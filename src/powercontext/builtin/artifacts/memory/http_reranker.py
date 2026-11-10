# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""HTTP scoring-service reranker with batched requests and global stable selection."""

from __future__ import annotations

import json
import math
from typing import Any

import httpx

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.inference import InferenceUsage
from powercontext.builtin.artifacts.memory.reranking import MemoryRerankDecision

DEFAULT_HTTP_RERANKER_POLICY_ID = "http-cross-encoder-v1"


def _validate_score(value: Any, /) -> float:
    """Accept only finite JSON numbers as service scores."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("rerank score must be a JSON number")
    score = float(value)
    if not math.isfinite(score):
        raise ValueError("rerank score must be finite")
    return score


class HTTPMemoryReranker:
    """Score Memory candidates over HTTP while preserving original hit identity."""

    def __init__(
        self,
        endpoint: str,
        /,
        *,
        client: httpx.AsyncClient,
        batch_size: int = 32,
        policy_id: str = DEFAULT_HTTP_RERANKER_POLICY_ID,
    ) -> None:
        if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
            raise ValueError("batch_size must be a positive integer")
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("endpoint must be a non-empty URL string")
        self._endpoint = endpoint
        self._client = client
        self._batch_size = batch_size
        self.policy_id = policy_id

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Score the full candidate pool in batches and select one global ordering."""

        if not isinstance(candidates, tuple):
            raise ValueError("rerank candidates must be a tuple")
        if not candidates:
            raise ValueError("rerank requires at least one candidate")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > len(candidates):
            raise ValueError("rerank limit must be between one and the candidate count")

        scores: dict[int, float] = {}
        requests = 0
        for start in range(0, len(candidates), self._batch_size):
            batch = candidates[start : start + self._batch_size]
            expected_ranks = list(range(start + 1, start + len(batch) + 1))
            payload_scores = await self._request_scores(query, batch, start)
            if sorted(item["rank"] for item in payload_scores) != expected_ranks:
                raise ValueError("rerank response must cover exactly this batch's ranks once each")
            for item in payload_scores:
                scores[item["rank"]] = _validate_score(item["score"])
            requests += 1

        ordered = sorted(scores, key=lambda rank: (-scores[rank], rank))
        return MemoryRerankDecision(
            selected_ranks=tuple(ordered[:limit]),
            usage=InferenceUsage(requests=requests),
        )

    async def _request_scores(
        self, query: str, batch: tuple[MemoryHit, ...], global_start: int, /
    ) -> list[dict[str, Any]]:
        """Send one batch request and validate the response schema exactly."""

        response = await self._client.post(
            self._endpoint,
            json={
                "query": query,
                "candidates": [
                    {"rank": index, "text": hit.text}
                    for index, hit in enumerate(batch, start=global_start + 1)
                ],
            },
        )
        # Non-2xx responses keep their native httpx exception.
        response.raise_for_status()
        try:
            payload = json.loads(response.content)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError(f"rerank response is not valid json: {error}") from error
        if not isinstance(payload, dict) or set(payload) != {"scores"}:
            raise ValueError("rerank response must contain exactly one scores field")
        raw_scores = payload["scores"]
        if not isinstance(raw_scores, list):
            raise ValueError("rerank scores must be a json array")
        normalized: list[dict[str, Any]] = []
        for item in raw_scores:
            if not isinstance(item, dict) or set(item) != {"rank", "score"}:
                raise ValueError("each score record must contain exactly rank and score")
            rank = item["rank"]
            if isinstance(rank, bool) or not isinstance(rank, int):
                raise ValueError("score rank must be an integer")
            normalized.append({"rank": rank, "score": item["score"]})
        return normalized


__all__ = ["DEFAULT_HTTP_RERANKER_POLICY_ID", "HTTPMemoryReranker"]
