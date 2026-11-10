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

"""Full-report PDF parsing with page-level Sources and exact evidence-page citation search."""

from __future__ import annotations

import hashlib
import io
import re
from urllib.parse import quote

import pypdf
from pydantic import BaseModel

from powercontext.builtin.artifacts.memory.models import MemoryCitation
from powercontext.builtin.runtime import GetMemoryEntryRequest, SearchMemoryRequest
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

PDF_PAGE_SOURCE_NAME = "pdf-page"

_IDENTITY_PREFIX = "pdf"
_MAX_IDENTITY_LENGTH = 256


def pdf_page_source_id(document_id: str, document_sha256: str, page_number: int, /) -> str:
    """Return the fixed revision-scoped page identity, collision-free and bounded."""

    if not isinstance(document_id, str) or not document_id.strip():
        raise ValueError("document_id must not be empty or pure whitespace")
    identity = f"{_IDENTITY_PREFIX}:{quote(document_id, safe='')}:{document_sha256}:{page_number}"
    if len(identity) > _MAX_IDENTITY_LENGTH:
        raise ValueError("pdf page source identity must not exceed 256 characters")
    return identity


class PDFDocumentInput(BaseModel):
    """One complete offline PDF document plus its caller identity."""

    document_id: str
    content: bytes


class PDFPageInput(BaseModel):
    """Exactly one physical page with its document revision identity and extracted text."""

    document_id: str
    document_sha256: str
    page_number: int
    text: str


class PDFPageSource(Source):
    """Durable captured evidence for exactly one physical PDF page."""

    document_id: str
    document_sha256: str
    page_number: int
    text: str


def parse_pdf_document(value: PDFDocumentInput, /) -> tuple[PDFPageInput, ...]:
    """Parse every physical page atomically, or raise ``ValueError`` without partial pages."""

    if not isinstance(value.document_id, str) or not value.document_id.strip():
        raise ValueError("document_id must not be empty or pure whitespace")
    if not isinstance(value.content, bytes) or not value.content:
        raise ValueError("pdf content must be non-empty bytes")
    document_sha256 = hashlib.sha256(value.content).hexdigest()
    try:
        reader = pypdf.PdfReader(io.BytesIO(value.content), strict=False)
        if reader.is_encrypted:
            result = reader.decrypt("")
            if hasattr(result, "name") and getattr(result, "name") == "NOT_DECRYPTED":
                raise ValueError("pdf requires a non-empty password")
        pages: list[PDFPageInput] = []
        for page_number, page in enumerate(reader.pages, start=1):
            text = page.extract_text()
            if not isinstance(text, str):
                text = ""
            pages.append(
                PDFPageInput(
                    document_id=value.document_id,
                    document_sha256=document_sha256,
                    page_number=page_number,
                    text=text,
                )
            )
    except ValueError:
        raise
    except Exception as error:  # pypdf parse, decrypt, and extraction failures are all atomic
        raise ValueError(f"unreadable pdf document: {error}") from error
    if not pages:
        raise ValueError("pdf document contains no pages")
    return tuple(pages)


class PDFPageSourceAdapter:
    """Resolve and read the page-level PDF Source for one exact input class."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        identity = pdf_page_source_id(value.document_id, value.document_sha256, value.page_number)
        return PDFPageSource(
            name=identity,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Expose one page as the standard ``powercontext.text-evidence`` shape."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_NAME,
            source_id=source.name,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(
    PDFPageSourceAdapter(),
    version="1",
    projections=(PDFPageTextEvidenceProjection(),),
)


_IDENTITY_PATTERN = re.compile(r"^pdf:(?P<document>[^:]*):(?P<sha256>[0-9a-f]{64}):(?P<page>[1-9][0-9]*)$")


def _page_location(source_id: str, /) -> tuple[str, int] | None:
    """Recover ``(document_id, page_number)`` from one page Source identity."""

    match = _IDENTITY_PATTERN.match(source_id)
    if match is None:
        return None
    return (quote(match.group("document"), safe=""), int(match.group("page")))


async def search_pdf_pages(
    memory,
    question: str,
    limit: int = 10,
) -> tuple[MemoryCitation, ...]:
    """Search one scoped Memory and return at most ``limit`` distinct page citations."""

    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("search_pdf_pages limit must be a positive integer")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question must be a non-empty string")

    pool = min(max(limit * 5, 40), 200)
    page = await memory.search(SearchMemoryRequest(query=question, mode="fts", limit=pool))
    citations: list[MemoryCitation] = []
    seen_locations: set[tuple[str, int]] = set()
    for hit in page.hits:
        citation = MemoryCitation(
            memory_ref=hit.memory_ref,
            entry_id=hit.entry_id,
            entry_version_id=hit.entry_version_id,
        )
        entry = (await memory.get(GetMemoryEntryRequest(citation=citation))).entry
        locations: list[tuple[str, int]] = []
        for reference in entry.sources:
            location = _page_location(reference.source_id)
            if location is not None:
                locations.append(location)
        if not locations:
            continue
        location = locations[0]
        if location in seen_locations:
            continue
        seen_locations.add(location)
        citations.append(citation)
        if len(citations) == limit:
            break
    return tuple(citations)


__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "parse_pdf_document",
    "pdf_page_source_id",
    "search_pdf_pages",
]
