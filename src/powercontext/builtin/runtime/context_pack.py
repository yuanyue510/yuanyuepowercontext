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

"""Context Pack wire protocol: full packs, prefix deltas, and independent reconstruction."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

PACK_SCHEMA = "powercontext.context-pack.v1"
DELTA_SCHEMA = "powercontext.context-pack-delta.v1"

DEFAULT_CHUNK_BYTES = 512
_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class ContextPackError(ValueError):
    """Raised for protocol, encoding, digest, or chunk validation failures."""


def _canonical_json(payload: dict[str, Any], /) -> bytes:
    """Encode one wire payload as UTF-8 JSON with sorted keys and compact separators."""

    try:
        return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ContextPackError(f"payload is not canonical json encodable: {error}") from error


def _encode_items(items: tuple[bytes, ...], /) -> list[str]:
    return [base64.b64encode(item).decode("ascii") for item in items]


def _decode_items(raw: object, field_name: str, /) -> tuple[bytes, ...]:
    if not isinstance(raw, list):
        raise ContextPackError(f"{field_name} must be a base64 string array")
    decoded: list[bytes] = []
    for value in raw:
        if not isinstance(value, str):
            raise ContextPackError(f"{field_name} entries must be base64 strings")
        try:
            decoded.append(base64.b64decode(value, validate=True))
        except (binascii.Error, ValueError) as error:
            raise ContextPackError(f"{field_name} entries must be valid base64") from error
    return tuple(decoded)


def _require_digest(value: object, field_name: str, /) -> str:
    if not isinstance(value, str) or _DIGEST_PATTERN.match(value) is None:
        raise ContextPackError(f"{field_name} must be a sha256:<hex> digest string")
    return value


def _solve_byte_count(build_payload, /) -> tuple[int, bytes]:
    """Find the self-consistent byte_count value whose encoding length equals itself."""

    guess = 1
    for _ in range(32):
        wire = _canonical_json(build_payload(guess))
        if len(wire) == guess:
            return guess, wire
        guess = len(wire)
    raise ContextPackError("byte_count failed to converge")


class ContextPack:
    """One complete context body with chunking, digest, and byte accounting."""

    __slots__ = ("_items", "_digest", "_byte_count", "_wire")

    def __init__(self, items: tuple[bytes, ...], digest: str, byte_count: int, wire: bytes, /) -> None:
        object.__setattr__(self, "_items", items)
        object.__setattr__(self, "_digest", digest)
        object.__setattr__(self, "_byte_count", byte_count)
        object.__setattr__(self, "_wire", wire)

    @classmethod
    def build(cls, items: tuple[bytes, ...], /) -> ContextPack:
        """Construct one full pack from an ordered tuple of raw chunk bytes."""

        if isinstance(items, (bytes, bytearray)) or not isinstance(items, tuple):
            raise ContextPackError("items must be a tuple of bytes chunks")
        normalized: list[bytes] = []
        for item in items:
            if isinstance(item, (bytes, bytearray)):
                normalized.append(bytes(item))
            else:
                raise ContextPackError("items must be a tuple of bytes chunks")
        chunks = tuple(normalized)
        digest = "sha256:" + hashlib.sha256(
            _canonical_json({"schema": PACK_SCHEMA, "items": _encode_items(chunks)})
        ).hexdigest()

        def build_payload(count: int) -> dict[str, Any]:
            return {"schema": PACK_SCHEMA, "items": _encode_items(chunks), "digest": digest, "byte_count": count}

        byte_count, wire = _solve_byte_count(build_payload)
        return cls(chunks, digest, byte_count, wire)

    @classmethod
    def from_content(cls, content: str, /, *, chunk_bytes: int = DEFAULT_CHUNK_BYTES) -> ContextPack:
        """Deterministically chunk one content string into a valid UTF-8 bounded pack."""

        if isinstance(chunk_bytes, bool) or not isinstance(chunk_bytes, int) or chunk_bytes < 1:
            raise ContextPackError("chunk_bytes must be a positive integer")
        if not isinstance(content, str):
            raise ContextPackError("content must be a string")
        chunks: list[bytes] = []
        pending: list[str] = []
        pending_bytes = 0
        for character in content:
            width = len(character.encode("utf-8"))
            if width > chunk_bytes:
                raise ContextPackError("chunk_bytes cannot hold a single utf-8 character")
            if pending_bytes + width > chunk_bytes:
                chunks.append("".join(pending).encode("utf-8"))
                pending = []
                pending_bytes = 0
            pending.append(character)
            pending_bytes += width
        if pending:
            chunks.append("".join(pending).encode("utf-8"))
        return cls.build(tuple(chunks))

    @classmethod
    def from_bytes(cls, data: bytes | bytearray, /) -> ContextPack:
        """Decode and fully validate one canonical wire pack."""

        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise ContextPackError("pack wire must be bytes")
        data = bytes(data)
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContextPackError(f"pack wire is not valid utf-8 json: {error}") from error
        if not isinstance(payload, dict) or set(payload) != {"schema", "items", "digest", "byte_count"}:
            raise ContextPackError("pack wire must contain exactly schema, items, digest, and byte_count")
        if payload["schema"] != PACK_SCHEMA:
            raise ContextPackError("pack wire schema mismatch")
        chunks = _decode_items(payload["items"], "items")
        digest = _require_digest(payload["digest"], "digest")
        recomputed = "sha256:" + hashlib.sha256(
            _canonical_json({"schema": PACK_SCHEMA, "items": _encode_items(chunks)})
        ).hexdigest()
        if digest != recomputed:
            raise ContextPackError("pack digest does not match its items")
        byte_count = payload["byte_count"]
        if isinstance(byte_count, bool) or not isinstance(byte_count, int) or byte_count != len(data):
            raise ContextPackError("pack byte_count does not match its wire size")

        def build_payload(count: int) -> dict[str, Any]:
            return {"schema": PACK_SCHEMA, "items": _encode_items(chunks), "digest": digest, "byte_count": count}

        expected_count, wire = _solve_byte_count(build_payload)
        if byte_count != expected_count or data != wire:
            raise ContextPackError("pack wire is not canonical")
        return cls(chunks, digest, byte_count, wire)

    @property
    def items(self) -> tuple[bytes, ...]:
        return self._items

    @property
    def digest(self) -> str:
        return self._digest

    @property
    def byte_count(self) -> int:
        return self._byte_count

    def to_bytes(self) -> bytes:
        return self._wire

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ContextPack):
            return NotImplemented
        return self._items == other._items and self._digest == other._digest

    def __hash__(self) -> int:
        return hash((self._items, self._digest))


@dataclass(frozen=True)
class ContextPackDelta:
    """One prefix-reuse delta carrying the target's non-shared suffix chunks."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...] = field(default=())

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack, /) -> ContextPackDelta:
        """Select the longest valid common prefix and carry the target suffix."""

        if not isinstance(base, ContextPack) or not isinstance(target, ContextPack):
            raise ContextPackError("delta endpoints must be ContextPack values")
        prefix = 0
        for base_item, target_item in zip(base.items, target.items):
            if base_item != target_item:
                break
            prefix += 1
        return cls(base.digest, target.digest, prefix, target.items[prefix:])

    @classmethod
    def from_bytes(cls, data: bytes | bytearray, /) -> ContextPackDelta:
        """Decode and validate one canonical wire delta."""

        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise ContextPackError("delta wire must be bytes")
        try:
            payload = json.loads(bytes(data).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContextPackError(f"delta wire is not valid utf-8 json: {error}") from error
        required = {"schema", "base_digest", "target_digest", "prefix_items", "appended"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise ContextPackError("delta wire fields do not match the contract")
        if payload["schema"] != DELTA_SCHEMA:
            raise ContextPackError("delta wire schema mismatch")
        base_digest = _require_digest(payload["base_digest"], "base_digest")
        target_digest = _require_digest(payload["target_digest"], "target_digest")
        prefix = payload["prefix_items"]
        if type(prefix) is not int or prefix < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        appended = _decode_items(payload["appended"], "appended")
        return cls(base_digest, target_digest, prefix, appended)

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())

    def to_bytes(self) -> bytes:
        return _canonical_json(
            {
                "schema": DELTA_SCHEMA,
                "base_digest": self.base_digest,
                "target_digest": self.target_digest,
                "prefix_items": self.prefix_items,
                "appended": _encode_items(self.appended),
            }
        )


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Validate one delta against its base pack and rebuild the target pack."""

    if not isinstance(base, ContextPack) or not isinstance(delta, ContextPackDelta):
        raise ContextPackError("apply_context_pack_delta requires a base pack and a delta")
    if delta.base_digest != base.digest:
        raise ContextPackError("delta base digest does not match the provided base pack")
    if type(delta.prefix_items) is not int or delta.prefix_items < 0 or delta.prefix_items > len(base.items):
        raise ContextPackError("delta prefix_items is out of bounds for the base pack")
    rebuilt = ContextPack.build(base.items[: delta.prefix_items] + delta.appended)
    if rebuilt.digest != delta.target_digest:
        raise ContextPackError("delta target digest does not match the rebuilt pack")
    return rebuilt


__all__ = [
    "DEFAULT_CHUNK_BYTES",
    "DELTA_SCHEMA",
    "PACK_SCHEMA",
    "ContextPack",
    "ContextPackDelta",
    "ContextPackError",
    "apply_context_pack_delta",
]
