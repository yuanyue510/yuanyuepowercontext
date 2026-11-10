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

"""Source lifecycle: dependency-driven Memory and Topic Memory availability.

Callers register the evidence graph explicitly (Sources, Memory citations, and
Topic Memory artifact references bound with ``all``/``any`` parent policies),
then apply availability events on Sources. Availability propagates through the
registered DAG, mirrors onto native Memory entry state, and gates native Topic
Memory search and Context preparation while audit reads keep working.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import insert, select, update

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.persistence.tables import LIFECYCLE_EVENTS_TABLE, LIFECYCLE_NODES_TABLE
from powercontext.builtin.runtime.models import GetMemoryEntryRequest
from powercontext.builtin.sources import validate_scope_id
from powercontext.errors import ArtifactNotFoundError
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from powercontext.builtin.runtime.application import BuiltinRuntime

_TOPIC_MEMORY_FAMILY = "topic-memory"


class SourceLifecycleError(ValueError):
    """Raised for invalid lifecycle registrations, events, and resolutions."""


class SourceLifecycleEvent(BaseModel):
    """One availability transition for one registered Source node."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    reason: str
    revision: int = Field(strict=True, gt=0)
    sequence: int = Field(strict=True, gt=0)
    available: bool = Field(strict=True)

    @field_validator("node_id", "reason")
    @classmethod
    def _reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("lifecycle node_id and reason must contain non-whitespace content")  # noqa: TRY003
        return value


@dataclass(frozen=True)
class _Node:
    node_id: str
    ordinal: int
    kind: str
    policy: str | None
    parents: tuple[str, ...]
    reference: dict[str, Any]
    lifecycle_revision: int | None
    available: bool

    def binding(self) -> tuple[Any, ...]:
        return (
            self.kind,
            self.policy,
            self.parents,
            _canonical_json(self.reference),
            self.lifecycle_revision,
        )


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _require_node_id(node_id: str) -> str:
    if not isinstance(node_id, str) or not node_id.strip() or node_id != node_id.strip():
        raise SourceLifecycleError("node_id must be non-empty trimmed text")
    if len(node_id) > 256:
        raise SourceLifecycleError("node_id is too long")
    return node_id


def _require_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise SourceLifecycleError(f"{field} must be a positive integer")
    return value


class _LifecycleRepository:
    """Dialect-neutral persistence for lifecycle nodes and events."""

    def __init__(self, database: Any) -> None:
        self._database = database

    async def load_nodes(self, scope_id: str) -> dict[str, _Node]:
        async with self._database.transaction() as connection:
            rows = (
                await connection.execute(
                    select(
                        LIFECYCLE_NODES_TABLE.c.node_id,
                        LIFECYCLE_NODES_TABLE.c.ordinal,
                        LIFECYCLE_NODES_TABLE.c.kind,
                        LIFECYCLE_NODES_TABLE.c.policy,
                        LIFECYCLE_NODES_TABLE.c.parents,
                        LIFECYCLE_NODES_TABLE.c.reference,
                        LIFECYCLE_NODES_TABLE.c.lifecycle_revision,
                        LIFECYCLE_NODES_TABLE.c.available,
                    )
                    .where(LIFECYCLE_NODES_TABLE.c.scope_id == scope_id)
                    .order_by(LIFECYCLE_NODES_TABLE.c.ordinal)
                )
            ).all()
        nodes: dict[str, _Node] = {}
        for row in rows:
            nodes[str(row[0])] = _Node(
                node_id=str(row[0]),
                ordinal=int(row[1]),
                kind=str(row[2]),
                policy=None if row[3] is None else str(row[3]),
                parents=tuple(str(item) for item in json.loads(str(row[4]))),
                reference=json.loads(str(row[5])),
                lifecycle_revision=None if row[6] is None else int(row[6]),
                available=bool(row[7]),
            )
        return nodes

    async def insert_node(self, scope_id: str, node: _Node) -> None:
        async with self._database.transaction() as connection:
            await connection.execute(
                insert(LIFECYCLE_NODES_TABLE).values(
                    scope_id=scope_id,
                    node_id=node.node_id,
                    ordinal=node.ordinal,
                    kind=node.kind,
                    policy=node.policy,
                    parents=_canonical_json(list(node.parents)),
                    reference=_canonical_json(node.reference),
                    lifecycle_revision=node.lifecycle_revision,
                    available=node.available,
                )
            )

    async def save_availability(self, scope_id: str, node_ids: dict[str, bool]) -> None:
        if not node_ids:
            return
        async with self._database.transaction() as connection:
            for node_id, available in node_ids.items():
                await connection.execute(
                    update(LIFECYCLE_NODES_TABLE)
                    .where(
                        LIFECYCLE_NODES_TABLE.c.scope_id == scope_id,
                        LIFECYCLE_NODES_TABLE.c.node_id == node_id,
                    )
                    .values(available=available)
                )

    async def last_event(self, scope_id: str, node_id: str) -> dict[str, Any] | None:
        async with self._database.transaction() as connection:
            row = (
                await connection.execute(
                    select(
                        LIFECYCLE_EVENTS_TABLE.c.sequence,
                        LIFECYCLE_EVENTS_TABLE.c.revision,
                        LIFECYCLE_EVENTS_TABLE.c.available,
                        LIFECYCLE_EVENTS_TABLE.c.reason,
                    )
                    .where(
                        LIFECYCLE_EVENTS_TABLE.c.scope_id == scope_id,
                        LIFECYCLE_EVENTS_TABLE.c.node_id == node_id,
                    )
                    .order_by(LIFECYCLE_EVENTS_TABLE.c.sequence.desc())
                    .limit(1)
                )
            ).one_or_none()
        if row is None:
            return None
        return {
            "sequence": int(row[0]),
            "revision": int(row[1]),
            "available": bool(row[2]),
            "reason": str(row[3]),
        }

    async def append_event(self, scope_id: str, event: SourceLifecycleEvent) -> None:
        async with self._database.transaction() as connection:
            await connection.execute(
                insert(LIFECYCLE_EVENTS_TABLE).values(
                    scope_id=scope_id,
                    node_id=event.node_id,
                    sequence=event.sequence,
                    revision=event.revision,
                    available=event.available,
                    reason=event.reason,
                )
            )

    async def next_ordinal(self, scope_id: str) -> int:
        async with self._database.transaction() as connection:
            value = await connection.scalar(
                select(LIFECYCLE_NODES_TABLE.c.ordinal)
                .where(LIFECYCLE_NODES_TABLE.c.scope_id == scope_id)
                .order_by(LIFECYCLE_NODES_TABLE.c.ordinal.desc())
                .limit(1)
            )
        return 0 if value is None else int(value) + 1


def _database_of(runtime: BuiltinRuntime) -> Any:
    records = runtime._record_service
    if records is None:
        raise SourceLifecycleError("lifecycle persistence requires the built-in record service")
    database = getattr(records, "database", None)
    if database is None:
        raise SourceLifecycleError("lifecycle persistence requires a relational record service")
    return database


def decode_reference(reference: dict[str, Any]) -> Any:
    """Rebuild the registered public reference object from its stored form."""

    kind = reference.get("kind")
    if kind == "source":
        return SourceRef(source_type=str(reference["source_type"]), source_id=str(reference["source_id"]))
    if kind == "memory":
        return MemoryCitation(
            memory_ref=ArtifactRef(**reference["memory_ref"]),
            entry_id=str(reference["entry_id"]),
            entry_version_id=str(reference["entry_version_id"]),
        )
    if kind == "topic":
        return ArtifactRef(
            family=str(reference["family"]),
            artifact_id=str(reference["artifact_id"]),
            revision=int(reference["revision"]),
        )
    raise SourceLifecycleError("unknown reference kind")


class SourceLifecycleService:
    """Operate one Scope's evidence-dependency lifecycle."""

    def __init__(self, runtime: BuiltinRuntime, scope_id: str) -> None:
        self._runtime = runtime
        self._repository = _LifecycleRepository(_database_of(runtime))
        self.scope_id = validate_scope_id(scope_id)

    # ------------------------------------------------------------------ registration

    async def register_source(self, node_id: str, source_ref: SourceRef, /, *, revision: int) -> None:
        node_id = _require_node_id(node_id)
        _require_positive_int(revision, "revision")
        records = self._runtime.records.for_scope(self.scope_id)
        await records.get_source(source_ref.source_type, source_ref.source_id)
        reference = {
            "kind": "source",
            "source_type": source_ref.source_type,
            "source_id": source_ref.source_id,
        }
        await self._register_node(node_id, kind="source", policy=None, parents=(), reference=reference,
                                  lifecycle_revision=revision, default_available=True)

    async def register_memory(self, node_id: str, citation: MemoryCitation, /, *, parents: tuple[str, ...], policy: str) -> None:
        node_id = _require_node_id(node_id)
        parents = self._validate_parents(node_id, parents, policy)
        memory = self._runtime.memory.for_scope(self.scope_id)
        await memory.get(GetMemoryEntryRequest(citation=citation))
        reference = {
            "kind": "memory",
            "memory_ref": citation.memory_ref.model_dump(mode="json"),
            "entry_id": citation.entry_id,
            "entry_version_id": citation.entry_version_id,
        }
        available = await self._derived_availability(parents, policy)
        await self._register_node(node_id, kind="memory", policy=policy, parents=parents,
                                  reference=reference, lifecycle_revision=None, default_available=available)
        if not available:
            await self._reconcile_memory([(reference, False)])

    async def register_topic(self, node_id: str, artifact_ref: ArtifactRef, /, *, parents: tuple[str, ...], policy: str) -> None:
        node_id = _require_node_id(node_id)
        parents = self._validate_parents(node_id, parents, policy)
        if artifact_ref.family != _TOPIC_MEMORY_FAMILY:
            raise SourceLifecycleError("topic nodes bind a topic-memory ArtifactRef")
        records = self._runtime.records.for_scope(self.scope_id)
        await records.get_artifact(artifact_ref.family, artifact_ref.artifact_id)
        reference = {
            "kind": "topic",
            "family": artifact_ref.family,
            "artifact_id": artifact_ref.artifact_id,
            "revision": artifact_ref.revision,
        }
        available = await self._derived_availability(parents, policy)
        await self._register_node(node_id, kind="topic", policy=policy, parents=parents,
                                  reference=reference, lifecycle_revision=None, default_available=available)

    def _validate_parents(self, node_id: str, parents: tuple[str, ...], policy: str) -> tuple[str, ...]:
        if policy not in {"all", "any"}:
            raise SourceLifecycleError("policy must be 'all' or 'any'")
        if not parents:
            raise SourceLifecycleError("derived nodes require at least one parent")
        if len(set(parents)) != len(parents):
            raise SourceLifecycleError("parents must not repeat")
        if node_id in parents:
            raise SourceLifecycleError("nodes cannot depend on themselves")
        return tuple(_require_node_id(parent) for parent in parents)

    async def _derived_availability(self, parents: tuple[str, ...], policy: str) -> bool:
        nodes = await self._repository.load_nodes(self.scope_id)
        for parent in parents:
            if parent not in nodes:
                raise SourceLifecycleError(f"parent node is not registered: {parent}")
        supports = [nodes[parent].available for parent in parents]
        return all(supports) if policy == "all" else any(supports)

    async def _register_node(
        self,
        node_id: str,
        *,
        kind: str,
        policy: str | None,
        parents: tuple[str, ...],
        reference: dict[str, Any],
        lifecycle_revision: int | None,
        default_available: bool,
    ) -> None:
        async with self._runtime._scoped_operation(self.scope_id):
            async with self._runtime._locked(self.scope_id):
                nodes = await self._repository.load_nodes(self.scope_id)
                existing = nodes.get(node_id)
                if existing is not None:
                    binding = (kind, policy, parents, _canonical_json(reference), lifecycle_revision)
                    if existing.binding() != binding:
                        raise SourceLifecycleError(f"node is already bound differently: {node_id}")
                    return
                ordinal = await self._repository.next_ordinal(self.scope_id)
                await self._repository.insert_node(
                    self.scope_id,
                    _Node(
                        node_id=node_id,
                        ordinal=ordinal,
                        kind=kind,
                        policy=policy,
                        parents=parents,
                        reference=reference,
                        lifecycle_revision=lifecycle_revision,
                        available=default_available,
                    ),
                )

    # ------------------------------------------------------------------ events

    async def apply(self, event: SourceLifecycleEvent, /) -> list[str]:
        """Apply one Source availability event and return the sorted active node ids."""

        _require_node_id(event.node_id)
        async with self._runtime._scoped_operation(self.scope_id):
            async with self._runtime._locked(self.scope_id):
                nodes = await self._repository.load_nodes(self.scope_id)
                node = nodes.get(event.node_id)
                if node is None or node.kind != "source":
                    raise SourceLifecycleError(f"event targets an unregistered Source: {event.node_id}")
                if node.lifecycle_revision != event.revision:
                    raise SourceLifecycleError("event revision does not match the registered lifecycle revision")
                last = await self._repository.last_event(self.scope_id, event.node_id)
                if last is not None:
                    if event.sequence < last["sequence"]:
                        raise SourceLifecycleError("event sequence must increase monotonically")
                    if event.sequence == last["sequence"]:
                        replay = (
                            last["revision"] == event.revision
                            and last["available"] == event.available
                            and last["reason"] == event.reason
                        )
                        if not replay:
                            raise SourceLifecycleError("event sequence was already used with different content")
                if last is None or event.sequence > last["sequence"]:
                    await self._repository.append_event(self.scope_id, event)
                    if node.available != event.available:
                        await self._repository.save_availability(self.scope_id, {event.node_id: event.available})
            nodes = await self._repository.load_nodes(self.scope_id)
        return await self._propagate(nodes)

    async def _propagate(self, nodes: dict[str, _Node]) -> list[str]:
        ordered = sorted(nodes.values(), key=lambda node: node.ordinal)
        availability: dict[str, bool] = {}
        changed: dict[str, bool] = {}
        for node in ordered:
            if node.kind == "source":
                availability[node.node_id] = node.available
                continue
            supports = [availability.get(parent, False) for parent in node.parents]
            available = all(supports) if node.policy == "all" else any(supports)
            availability[node.node_id] = available
            if available != node.available:
                changed[node.node_id] = available
        if changed:
            await self._repository.save_availability(self.scope_id, changed)
        # Reconcile every registered Memory node against its desired state: the
        # manifest check makes this a no-op when states already agree, so event
        # replays never add Memory revisions and interrupted runs resume here.
        memory_targets = [(node.reference, availability[node.node_id]) for node in ordered if node.kind == "memory"]
        await self._reconcile_memory(memory_targets)
        return sorted(node_id for node_id, available in availability.items() if available)

    async def _reconcile_memory(self, targets: list[tuple[dict[str, Any], bool]]) -> None:
        """Mirror desired availability onto native Memory entry state (idempotent)."""

        if not targets:
            return
        runtime = self._runtime
        async with runtime._context(self.scope_id) as context:
            async with runtime._locked(self.scope_id):
                service = context.artifacts.memory
                artifact_id = context.artifacts.memory_artifact_id
                try:
                    current = await service.head(artifact_id)
                except ArtifactNotFoundError:
                    return
                for reference, desired in targets:
                    if reference.get("kind") != "memory":
                        continue
                    memory_ref = ArtifactRef(**reference["memory_ref"])
                    if memory_ref.artifact_id != artifact_id:
                        continue
                    current = await self._set_entry_state(service, current, str(reference["entry_id"]), desired)

    async def _set_entry_state(self, service: Any, current: Any, entry_id: str, desired: bool) -> Any:
        manifest = {entry.entry_id: entry for entry in current.content.manifest.entries}
        entry = manifest.get(entry_id)
        if entry is None:
            return current
        if (entry.state == "active") == desired:
            return current
        versions = {version.entry_id: version for version in await service.entries(current)}
        version = versions.get(entry_id)
        if version is None:
            return current
        if desired:
            return await service.reactivate(current, entries=(version,), reason="source lifecycle recovery")
        return await service.forget(current, entries=(version,), reason="source lifecycle withdrawal")

    # ------------------------------------------------------------------ resolution

    async def resolve(self, node_id: str, /, *, purpose: str) -> Any:
        """Return the node's registered reference for one read purpose."""

        if purpose not in {"generation", "audit"}:
            raise SourceLifecycleError("purpose must be 'generation' or 'audit'")
        nodes = await self._repository.load_nodes(self.scope_id)
        node = nodes.get(_require_node_id(node_id))
        if node is None:
            raise SourceLifecycleError(f"unknown lifecycle node: {node_id}")
        if purpose == "generation" and not node.available:
            raise SourceLifecycleError(f"node is not available for generation: {node_id}")
        return decode_reference(node.reference)

    async def active_ids(self) -> list[str]:
        nodes = await self._repository.load_nodes(self.scope_id)
        return sorted(node_id for node_id, node in nodes.items() if node.available)


class LifecycleApplication:
    """Select the scoped Source lifecycle service."""

    def __init__(self, runtime: BuiltinRuntime) -> None:
        self._runtime = runtime

    def for_scope(self, scope_id: str, /) -> SourceLifecycleService:
        return SourceLifecycleService(self._runtime, scope_id)


async def topic_availability_map(runtime: BuiltinRuntime, scope_id: str) -> dict[str, bool] | None:
    """Return ``{artifact_id: available}`` for registered Topic nodes, or None when unused."""

    records = runtime._record_service
    if records is None:
        return None
    database = getattr(records, "database", None)
    if database is None:
        return None
    nodes = await _LifecycleRepository(database).load_nodes(scope_id)
    topics = {node.reference["artifact_id"]: node.available for node in nodes.values() if node.kind == "topic"}
    return topics or None


__all__ = [
    "LifecycleApplication",
    "SourceLifecycleError",
    "SourceLifecycleEvent",
    "SourceLifecycleService",
    "topic_availability_map",
]
