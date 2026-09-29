import logging
from typing import Any

from google import genai
from google.genai import types
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.resolution import ExtractedCandidateProfile, RawCandidate

logger = logging.getLogger(__name__)

EXTRACTION_SYSTEM_INSTRUCTION = (
    "You are a strict factual data extraction engine for contact and profile resolution. "
    "Your ONLY task is to extract explicitly stated factual contact fields from messy, "
    "unstructured provider text snippets. "
    "Extract only: name, email, phone, employer, job_title, and location. "
    "CRITICAL RULES:\n"
    "1. Do NOT guess, extrapolate, or invent missing information.\n"
    "2. If a field is not explicitly present in the source text, set its value to null.\n"
    "3. Do not attempt to score, match, or judge identity."
)


class GeminiExtractionError(Exception):
    """Raised when Gemini extraction fails, times out, violates schema, or is unavailable."""

    pass


class GeminiExtractor:
    """Extracts factual profile fields from messy unstructured provider evidence using Gemini."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float | None = None,
        client: Any | None = None,
    ) -> None:
        self.api_key = api_key or settings.GEMINI_API_KEY
        self.model = model or settings.GEMINI_MODEL
        self.timeout = timeout or settings.GEMINI_TIMEOUT_SECONDS
        self._client: Any = client

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not self.api_key:
            raise GeminiExtractionError(
                "Gemini API key is not configured (GEMINI_API_KEY environment variable required)."
            )
        try:
            self._client = genai.Client(api_key=self.api_key)
            return self._client
        except Exception as e:
            raise GeminiExtractionError(f"Failed to initialize Gemini client: {e}") from e

    def extract_from_unstructured_text(self, text: str) -> ExtractedCandidateProfile:
        """Extract structured profile fields from raw messy provider evidence."""
        if not text or not text.strip():
            raise GeminiExtractionError("Evidence text is empty.")

        client = self._get_client()
        prompt = (
            f"Extract structured profile fields from the following raw provider evidence:\n\n"
            f'"""\n{text.strip()}\n"""'
        )

        try:
            config = types.GenerateContentConfig(
                system_instruction=EXTRACTION_SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=ExtractedCandidateProfile,
                temperature=0.0,
            )
            response = client.models.generate_content(
                model=self.model,
                contents=prompt,
                config=config,
            )
        except Exception as e:
            err_msg = str(e)
            if self.api_key and self.api_key in err_msg:
                err_msg = err_msg.replace(self.api_key, "***")
            logger.error("Gemini extraction call failed: %s", err_msg)
            raise GeminiExtractionError(f"Gemini API extraction failed: {err_msg}") from e

        if not response or not response.text:
            raise GeminiExtractionError("Gemini returned empty response text.")

        try:
            return ExtractedCandidateProfile.model_validate_json(response.text)
        except (ValidationError, Exception) as e:
            logger.error("Gemini output failed schema validation: %s", e)
            raise GeminiExtractionError(f"Gemini output failed schema validation: {e}") from e

    def extract_candidate_from_evidence(
        self,
        provider_source: str,
        provider_record_id: str,
        raw_evidence_text: str,
        provenance_title: str = "Synthetic Field Notes",
    ) -> RawCandidate:
        """Extract profile fields and construct a validated RawCandidate record."""
        extracted = self.extract_from_unstructured_text(raw_evidence_text)
        if not extracted.name or not extracted.name.strip():
            raise GeminiExtractionError(
                f"Extraction from '{provider_record_id}' did not identify a valid contact name."
            )

        return RawCandidate(
            provider_source=provider_source,
            provider_record_id=provider_record_id,
            name=extracted.name.strip(),
            email=extracted.email.strip() if extracted.email else None,
            phone=extracted.phone.strip() if extracted.phone else None,
            employer=extracted.employer.strip() if extracted.employer else None,
            job_title=extracted.job_title.strip() if extracted.job_title else None,
            location=extracted.location.strip() if extracted.location else None,
            provenance_summary=(
                f"Structured from provider evidence using Gemini ({provenance_title}): "
                f'"{raw_evidence_text.strip()}"'
            ),
        )
