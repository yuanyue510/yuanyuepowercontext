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

"""Concurrent Embedding request coalescing with a bounded LRU vector cache.

One wrapper coordinates shared batches across concurrent ``embed`` calls in a
single event loop: identical texts share one underlying request, late callers
join requests that are still executing, and successful vectors are cached for
later calls. Call cancellation stays isolated (a cancelled caller never cancels
the shared batch), local failures propagate only to the waiters of the failing
batch, and every call reports usage aggregated over the distinct underlying
batches it actually waited for.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from itertools import islice

from powercontext.builtin.inference.models import EmbeddingResult, InferenceUsage
from powercontext.builtin.inference.protocols import EmbeddingModel


class _Batch:
    """One in-flight underlying request over deduplicated texts."""

    __slots__ = ("texts", "waiters", "vectors", "usage")

    def __init__(self, texts: tuple[str, ...]) -> None:
        self.texts = texts
        self.waiters: list[asyncio.Future] = []
        self.vectors: dict[str, tuple[float, ...]] = {}
        self.usage: InferenceUsage = InferenceUsage(requests=0)


class CoalescingEmbeddingModel:
    """Merge concurrent identical Embedding texts and cache successful vectors."""

    def __init__(
        self,
        model: EmbeddingModel,
        *,
        max_batch_size: int = 64,
        coalesce_ms: float = 5.0,
        cache_size: int = 1024,
    ) -> None:
        if isinstance(max_batch_size, bool) or not isinstance(max_batch_size, int) or max_batch_size < 1:
            raise ValueError("max_batch_size must be a positive integer")  # noqa: TRY003
        if isinstance(coalesce_ms, bool) or not isinstance(coalesce_ms, (int, float)) or coalesce_ms < 0:
            raise ValueError("coalesce_ms must be a non-negative number of milliseconds")  # noqa: TRY003
        if isinstance(cache_size, bool) or not isinstance(cache_size, int) or cache_size < 0:
            raise ValueError("cache_size must be a non-negative integer")  # noqa: TRY003
        self._model = model
        self.profile = model.profile
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = coalesce_ms / 1000.0
        self._cache_size = cache_size
        self._cache: OrderedDict[str, tuple[float, ...]] | None = OrderedDict() if cache_size > 0 else None
        self._lock = asyncio.Lock()
        # Texts waiting to be formed into batches, in arrival order.
        self._pool: OrderedDict[str, None] = OrderedDict()
        # Text -> batch that will (or already does) compute them.
        self._inflight: dict[str, _Batch] = {}
        # Text -> caller futures waiting for the batch that will compute them.
        self._waiters: dict[str, list[asyncio.Future]] = {}
        self._drain_task: asyncio.Task | None = None

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        """Return one ordered vector per input text, sharing underlying requests."""

        vectors: dict[int, tuple[float, ...]] = {}
        waited: dict[int, _Batch] = {}
        futures: list[asyncio.Future] = []
        call_pool_texts: set[str] = set()
        loop = asyncio.get_running_loop()
        async with self._lock:
            for index, text in enumerate(texts):
                cached = None if self._cache is None else self._cache.get(text)
                if cached is not None:
                    self._cache.move_to_end(text)
                    vectors[index] = cached
                    continue
                batch = self._inflight.get(text)
                if batch is not None:
                    if id(batch) not in waited:
                        future: asyncio.Future = loop.create_future()
                        futures.append(future)
                        waited[id(batch)] = batch
                        batch.waiters.append(future)
                    continue
                if text not in self._pool:
                    self._pool[text] = None
                if text not in call_pool_texts:
                    call_pool_texts.add(text)
                    future = loop.create_future()
                    futures.append(future)
                    self._waiters.setdefault(text, []).append(future)
            if self._coalesce_seconds > 0:
                if self._pool:
                    self._schedule_drain()
            else:
                self._form_batches()

        if not futures:
            return EmbeddingResult(
                vectors=tuple(vectors[index] for index in range(len(texts))),
                usage=InferenceUsage(requests=0),
            )
        for batch in await asyncio.gather(*futures):
            waited[id(batch)] = batch
        for index, text in enumerate(texts):
            if index not in vectors:
                vectors[index] = next(batch.vectors[text] for batch in waited.values() if text in batch.vectors)
        return EmbeddingResult(vectors=tuple(vectors[index] for index in range(len(texts))), usage=_sum_usage(waited))

    def _schedule_drain(self) -> None:
        """Schedule one coalescing-window drain (caller holds the lock)."""

        if self._drain_task is not None and not self._drain_task.done():
            return

        async def _delayed() -> None:
            await asyncio.sleep(self._coalesce_seconds)
            async with self._lock:
                self._form_batches()

        self._drain_task = asyncio.create_task(_delayed())

    def _form_batches(self) -> None:
        """Move queued texts into at-most-``max_batch_size`` batches (caller holds the lock)."""

        while self._pool:
            texts = tuple(islice(self._pool.keys(), self._max_batch_size))
            batch = _Batch(texts)
            for text in texts:
                del self._pool[text]
                self._inflight[text] = batch
                batch.waiters.extend(self._waiters.pop(text, ()))
            asyncio.create_task(self._execute(batch))

    async def _execute(self, batch: _Batch) -> None:
        try:
            result = await self._model.embed(batch.texts)
            if len(result.vectors) != len(batch.texts):
                raise ValueError(  # noqa: TRY003
                    "embedding provider returned the wrong vector count for a batch"
                )
            for text, vector in zip(batch.texts, result.vectors, strict=True):
                batch.vectors[text] = tuple(vector)
            batch.usage = result.usage
            if self._cache is not None:
                for text in batch.texts:
                    self._cache[text] = batch.vectors[text]
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
            for future in batch.waiters:
                if not future.done():
                    future.set_result(batch)
        except BaseException as error:  # noqa: BLE001 - propagate every failure to the waiters
            for future in batch.waiters:
                if not future.done():
                    future.set_exception(error)
        finally:
            async with self._lock:
                for text in batch.texts:
                    if self._inflight.get(text) is batch:
                        del self._inflight[text]
                if self._coalesce_seconds > 0 and self._pool:
                    self._schedule_drain()


def _sum_usage(batches: dict[int, _Batch]) -> InferenceUsage:
    requests = 0
    input_values: list[int] = []
    output_values: list[int] = []
    saw_input = False
    saw_output = False
    for batch in batches.values():
        usage = batch.usage
        requests += usage.requests
        if usage.input_tokens is not None:
            saw_input = True
            input_values.append(usage.input_tokens)
        if usage.output_tokens is not None:
            saw_output = True
            output_values.append(usage.output_tokens)
    return InferenceUsage(
        requests=requests,
        input_tokens=sum(input_values) if saw_input else None,
        output_tokens=sum(output_values) if saw_output else None,
    )


__all__ = ["CoalescingEmbeddingModel"]
