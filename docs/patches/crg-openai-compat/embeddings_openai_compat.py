"""OpenAI-compatible embedding provider for code-review-graph.

Speaks the OpenAI /v1/embeddings wire protocol. Works with:

- Ollama (``http://localhost:11434/v1``, e.g. ``nomic-embed-text``)
- LiteLLM / LocalAI / any private on-prem service that mimics OpenAI
- Real OpenAI (``text-embedding-3-small`` / ``-large``)
- Hubcode Desktop's in-process ONNX embedding server

Kept dependency-free — uses ``urllib.request`` like
``MiniMaxEmbeddingProvider``. Lazy-probes the output dimension on first
call unless the caller pins it via ``CRG_OPENAI_DIMENSION``.
"""

from __future__ import annotations

import json as _json
import logging
import os
import ssl
import time
import urllib.request
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


class OpenAICompatEmbeddingProvider:
    """Embed via any server speaking the OpenAI ``/v1/embeddings`` API.

    ``base_url`` is the OpenAI-style prefix that ends in ``/v1`` — we append
    ``/embeddings``. For Ollama: ``http://localhost:11434/v1``.

    The dimension is probed on first ``embed_query`` call unless the caller
    passes ``dimension`` explicitly. Some models (notably Ollama's
    ``nomic-embed-text``) vary output dimension by runtime config, so
    trusting the first response is the safe default.
    """

    _TIMEOUT_SEC = 60
    _MAX_RETRIES = 3
    _BATCH_SIZE = 100

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: Optional[str] = None,
        dimension: Optional[int] = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required for OpenAICompatEmbeddingProvider")
        if not model:
            raise ValueError("model is required for OpenAICompatEmbeddingProvider")
        # Normalize: strip trailing slash, ensure we can append /embeddings cleanly.
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key or ""
        self._dimension: Optional[int] = dimension

    # ------------------------------------------------------------------ API

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        results: list[list[float]] = []
        for i in range(0, len(texts), self._BATCH_SIZE):
            batch = texts[i : i + self._BATCH_SIZE]
            vectors = self._call_api(batch)
            results.extend(vectors)
            # Cache probed dimension from the first non-empty result.
            if self._dimension is None and vectors and vectors[0]:
                self._dimension = len(vectors[0])
        return results

    def embed_query(self, text: str) -> list[float]:
        vectors = self._call_api([text])
        if not vectors or not vectors[0]:
            raise RuntimeError(
                f"OpenAI-compatible embeddings endpoint returned empty vector for model={self._model}"
            )
        if self._dimension is None:
            self._dimension = len(vectors[0])
        return vectors[0]

    @property
    def dimension(self) -> int:
        if self._dimension is None:
            # Force a probe call. Caller may also pin via constructor or env.
            self.embed_query(" ")
        assert self._dimension is not None  # narrow for mypy
        return self._dimension

    @property
    def name(self) -> str:
        # Host tag helps humans read the graph metadata.
        host = urlparse(self._base_url).hostname or "?"
        return f"openai-compat://{host}/{self._model}"

    # --------------------------------------------------------------- helpers

    def _call_api(self, texts: list[str]) -> list[list[float]]:
        endpoint = f"{self._base_url}/embeddings"
        payload = _json.dumps({"model": self._model, "input": texts}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        last_exc: Exception | None = None
        for attempt in range(self._MAX_RETRIES):
            try:
                req = urllib.request.Request(endpoint, data=payload, headers=headers)
                ctx = ssl.create_default_context() if endpoint.startswith("https://") else None
                with urllib.request.urlopen(  # nosec B310 — user-provided endpoint, opt-in
                    req, timeout=self._TIMEOUT_SEC, context=ctx
                ) as resp:
                    body = _json.loads(resp.read().decode("utf-8"))
                data = body.get("data") or []
                if not isinstance(data, list):
                    raise RuntimeError(
                        f"OpenAI-compat endpoint returned unexpected 'data' shape: {type(data).__name__}"
                    )
                # OpenAI response: data = [{embedding: [...], index: 0}, ...]
                # Ordered by index; sort defensively in case the server doesn't.
                by_index = sorted(
                    data,
                    key=lambda d: d.get("index", 0) if isinstance(d, dict) else 0,
                )
                vectors = [
                    (d.get("embedding") if isinstance(d, dict) else None) or []
                    for d in by_index
                ]
                if len(vectors) != len(texts):
                    raise RuntimeError(
                        f"OpenAI-compat endpoint returned {len(vectors)} vectors for {len(texts)} inputs"
                    )
                return vectors
            except Exception as exc:  # noqa: BLE001 — retry on transport/5xx
                last_exc = exc
                err_str = str(exc)
                is_retryable = any(code in err_str for code in ("429", "500", "502", "503", "504"))
                if not is_retryable or attempt == self._MAX_RETRIES - 1:
                    raise
                wait = 2**attempt
                logger.warning(
                    "openai-compat embeddings error (attempt %d/%d), retrying in %ds: %s",
                    attempt + 1,
                    self._MAX_RETRIES,
                    wait,
                    exc,
                )
                time.sleep(wait)
        # Unreachable; keeps type-checkers happy.
        if last_exc:
            raise last_exc
        return []


# ----------------------------------------------------------------------------
# Env-var factory — lets callers resolve the provider from the environment
# without hardcoding config. Matches the existing Google/MiniMax pattern.
# ----------------------------------------------------------------------------


def provider_from_env() -> Optional[OpenAICompatEmbeddingProvider]:
    """Construct an ``OpenAICompatEmbeddingProvider`` from env vars, or None.

    Reads:
      CRG_OPENAI_BASE_URL (required)
      CRG_OPENAI_MODEL    (required)
      CRG_OPENAI_API_KEY  (optional)
      CRG_OPENAI_DIMENSION (optional, int)
    """
    base_url = os.environ.get("CRG_OPENAI_BASE_URL", "").strip()
    model = os.environ.get("CRG_OPENAI_MODEL", "").strip()
    if not base_url or not model:
        return None
    api_key = os.environ.get("CRG_OPENAI_API_KEY") or None
    dim_env = os.environ.get("CRG_OPENAI_DIMENSION")
    dimension: Optional[int] = None
    if dim_env:
        try:
            dimension = int(dim_env)
        except ValueError:
            logger.warning(
                "CRG_OPENAI_DIMENSION is set but not an int: %r — ignoring", dim_env
            )
    return OpenAICompatEmbeddingProvider(
        base_url=base_url,
        model=model,
        api_key=api_key,
        dimension=dimension,
    )


def is_loopback_url(url: str) -> bool:
    """True when *url* points at the local machine — used to skip the
    cloud-egress warning for on-prem / sidecar inference servers."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
