"""文本向量化。

两种后端：
* ``hash``    —— 确定性哈希向量（不依赖外部服务，评审环境开箱即用，默认）；
* ``minimax`` —— 调用 MiniMax 的 embo-01 嵌入接口（有 API Key 时启用）。

两者输出维度一致（默认 1024），写入 seekdb 的 VECTOR(1024) 列，
因此切换后端只需重新执行一次 ingest。
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Dict, Iterable, List, Sequence

from .config import Config

_ASCII_WORD = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")
_CJK = re.compile(r"[\u4e00-\u9fff]")
_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "be", "for", "on",
    "with", "as", "by", "at", "it", "this", "that", "from", "def", "self", "return",
}


def tokenize(text: str) -> List[str]:
    """英文按标识符切词，中文按字 + 二元组切词（无需分词依赖）。"""
    text = text or ""
    tokens = [w.lower() for w in _ASCII_WORD.findall(text)]
    tokens = [t for t in tokens if t not in _STOP and len(t) > 1]
    chars = _CJK.findall(text)
    tokens.extend(chars)
    tokens.extend("".join(pair) for pair in zip(chars, chars[1:]))
    return tokens


class HashingEmbedder:
    name = "hash-1024"

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim

    def embed(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        for token in tokenize(text):
            digest = hashlib.md5(token.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[idx] += sign
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0:
            return vec
        return [v / norm for v in vec]

    def embed_many(self, texts: Iterable[str]) -> List[List[float]]:
        return [self.embed(t) for t in texts]


class MiniMaxEmbedder:
    """MiniMax 嵌入后端。任何失败都会抛出异常，由调用方决定是否回退。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.name = f"minimax-{cfg.minimax_embed_model}"
        self.dim = cfg.embed_dim
        self._cache: Dict[str, List[float]] = {}

    def embed_many(self, texts: Sequence[str]) -> List[List[float]]:
        import urllib.request

        payload = json.dumps(
            {"model": self.cfg.minimax_embed_model, "texts": list(texts), "type": "db"},
            ensure_ascii=False,
        ).encode("utf-8")
        url = f"{self.cfg.minimax_base_url}/v1/embeddings"
        if self.cfg.minimax_group_id:
            url += f"?GroupId={self.cfg.minimax_group_id}"
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.cfg.minimax_api_key}",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        vectors = data.get("vectors") or []
        if len(vectors) != len(texts):
            raise RuntimeError(f"embedding count mismatch: {len(vectors)} != {len(texts)}")
        return [list(map(float, v)) for v in vectors]

    def embed(self, text: str) -> List[float]:
        return self.embed_many([text])[0]


def build_embedder(cfg: Config):
    """按配置选择后端；minimax 不可用时自动回退到 hash 并留下提示。"""
    if cfg.embed_provider == "minimax" and cfg.minimax_api_key:
        try:
            emb = MiniMaxEmbedder(cfg)
            probe = emb.embed_many(["probe"])
            if probe and len(probe[0]) == cfg.embed_dim:
                return emb
            print(f"[embed] MiniMax 返回维度 {len(probe[0])} != {cfg.embed_dim}，回退 hash")
        except Exception as exc:  # noqa: BLE001
            print(f"[embed] MiniMax 嵌入不可用，回退 hash: {exc}")
    return HashingEmbedder(cfg.embed_dim)
