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

"""Row-level CSV capture with stable per-row identity and exact evidence projection."""

from __future__ import annotations

import csv
import io
import json
from urllib.parse import quote

from pydantic import BaseModel

from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

CSV_ROW_SOURCE_NAME = "csv-row"

_IDENTITY_PREFIX = "csv"
_MAX_IDENTITY_LENGTH = 256


def _require_trimmed_document_id(document_id: str, /) -> str:
    if not isinstance(document_id, str) or not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be non-empty without leading or trailing whitespace")
    return document_id


class CSVDocumentInput(BaseModel):
    """Complete offline CSV document bytes plus its identity inputs."""

    document_id: str
    primary_key: str
    content: bytes


class CSVRowInput(BaseModel):
    """One exactly captured CSV row with its document and primary-key identity."""

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


class CSVRowSource(Source):
    """Durable captured evidence for exactly one CSV row."""

    source_id: str
    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


def csv_row_source_id(document_id: str, primary_key_value: str, /) -> str:
    """Return the fixed ``csv:{document}:{primary-key}`` row identity."""

    _require_trimmed_document_id(document_id)
    if not isinstance(primary_key_value, str) or not primary_key_value.strip():
        raise ValueError("primary_key_value must not be blank")
    identity = (
        f"{_IDENTITY_PREFIX}:"
        f"{quote(document_id, safe='')}:{quote(primary_key_value, safe='')}"
    )
    if len(identity) > _MAX_IDENTITY_LENGTH:
        raise ValueError("csv row source identity must not exceed 256 characters")
    return identity


def parse_csv_document(value: CSVDocumentInput, /) -> tuple[CSVRowInput, ...]:
    """Parse and validate a complete CSV document atomically, or raise ``ValueError``."""

    _require_trimmed_document_id(value.document_id)
    primary_key = value.primary_key
    if not isinstance(primary_key, str) or not primary_key:
        raise ValueError("primary_key must be a non-empty string")
    try:
        text = value.content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("csv content must decode as strict UTF-8") from error

    try:
        raw_rows = list(csv.reader(io.StringIO(text, newline=""), delimiter=",", quotechar='"', strict=True))
    except csv.Error as error:
        raise ValueError(f"malformed csv content: {error}") from error
    if not raw_rows:
        raise ValueError("csv document requires a header record")

    header = raw_rows[0]
    if not header:
        raise ValueError("csv header must not be empty")
    for column in header:
        if not column or not column.strip():
            raise ValueError("csv header fields must be non-empty and not pure whitespace")
    if len(set(header)) != len(header):
        raise ValueError("csv header fields must be unique")
    if primary_key not in header:
        raise ValueError(f"primary_key {primary_key!r} is not a header column")
    key_index = header.index(primary_key)
    width = len(header)

    rows: list[CSVRowInput] = []
    seen_keys: set[str] = set()
    for raw_row in raw_rows[1:]:
        if raw_row == []:
            continue
        if len(raw_row) != width:
            raise ValueError("csv data records must match the header width")
        primary_key_value = raw_row[key_index]
        if not primary_key_value or not primary_key_value.strip():
            raise ValueError("csv primary key values must not be blank")
        if primary_key_value in seen_keys:
            raise ValueError(f"duplicate primary key value {primary_key_value!r}")
        seen_keys.add(primary_key_value)
        rows.append(
            CSVRowInput(
                document_id=value.document_id,
                primary_key=primary_key,
                primary_key_value=primary_key_value,
                columns=tuple(header),
                values=tuple(raw_row),
            )
        )
    return tuple(rows)


class CSVRowSourceAdapter:
    """Resolve and read the row-level CSV Source for one exact input class."""

    input_class = CSVRowInput
    name = CSV_ROW_SOURCE_NAME
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        identity = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(
            name=identity,
            source_id=identity,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            primary_key=value.primary_key,
            primary_key_value=value.primary_key_value,
            columns=value.columns,
            values=value.values,
        )

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        return CSVRowInput(
            document_id=source.document_id,
            primary_key=source.primary_key,
            primary_key_value=source.primary_key_value,
            columns=source.columns,
            values=source.values,
        )


class CSVRowTextEvidenceProjection:
    """Expose one row as the standard ``powercontext.text-evidence`` shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = CSVRowSource
    output_class = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = {column: value for column, value in zip(source.columns, source.values, strict=True)}
        return TextEvidence(
            source_type=CSV_ROW_SOURCE_NAME,
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata={
                "document_id": source.document_id,
                "primary_key": source.primary_key,
                "primary_key_value": source.primary_key_value,
                "columns": list(source.columns),
                "row": row,
            },
        )


CSV_ROW_SOURCE_DEFINITION = AdapterSourceDefinition(
    CSVRowSourceAdapter(),
    version="1",
    projections=(CSVRowTextEvidenceProjection(),),
)

__all__ = [
    "CSV_ROW_SOURCE_DEFINITION",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "csv_row_source_id",
    "parse_csv_document",
]
