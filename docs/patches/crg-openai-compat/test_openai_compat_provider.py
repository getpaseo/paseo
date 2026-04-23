"""Unit tests for OpenAICompatEmbeddingProvider.

Run:  pytest tests/test_openai_compat_provider.py -v

Live integration test against a real OpenAI-compat endpoint is skipped
unless ``CRG_LIVE_OPENAI_TEST=1`` and ``CRG_OPENAI_BASE_URL`` are set.
"""

from __future__ import annotations

import io
import json
import os
from unittest.mock import MagicMock, patch

import pytest

from code_review_graph.embeddings_openai_compat import (
    OpenAICompatEmbeddingProvider,
    is_loopback_url,
    provider_from_env,
)


def _fake_http_response(payload: dict) -> MagicMock:
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    return resp


def _openai_style(vectors: list[list[float]]) -> dict:
    return {
        "data": [
            {"embedding": vec, "index": i, "object": "embedding"}
            for i, vec in enumerate(vectors)
        ],
        "model": "fake-model",
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


class TestBasics:
    def test_embed_returns_vectors_in_input_order(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(
                _openai_style([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])
            )
            got = provider.embed(["a", "b", "c"])
        assert got == [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]

    def test_embed_reorders_if_server_returns_out_of_order(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        payload = {
            "data": [
                {"embedding": [3.0], "index": 2},
                {"embedding": [1.0], "index": 0},
                {"embedding": [2.0], "index": 1},
            ]
        }
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(payload)
            got = provider.embed(["a", "b", "c"])
        assert got == [[1.0], [2.0], [3.0]]

    def test_dimension_is_probed_from_first_response(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(
                _openai_style([[0.0] * 384])
            )
            provider.embed_query("hello")
        assert provider.dimension == 384

    def test_explicit_dimension_is_respected(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model", dimension=768
        )
        assert provider.dimension == 768

    def test_api_key_sent_as_bearer_when_present(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model", api_key="sk-secret"
        )
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(_openai_style([[1.0]]))
            provider.embed_query("hi")
        req = urlopen.call_args.args[0]
        assert req.get_header("Authorization") == "Bearer sk-secret"

    def test_no_auth_header_when_api_key_blank(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model", api_key=""
        )
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(_openai_style([[1.0]]))
            provider.embed_query("hi")
        req = urlopen.call_args.args[0]
        assert req.get_header("Authorization") is None

    def test_base_url_is_normalized_and_endpoint_is_embeddings(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1/", model="fake-model"
        )
        with patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = _fake_http_response(_openai_style([[1.0]]))
            provider.embed_query("hi")
        req = urlopen.call_args.args[0]
        assert req.full_url == "http://fake/v1/embeddings"

    def test_empty_input_returns_empty_without_hitting_network(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        with patch("urllib.request.urlopen") as urlopen:
            assert provider.embed([]) == []
            urlopen.assert_not_called()


class TestRetry:
    def test_retries_on_5xx_and_succeeds(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        ok = _fake_http_response(_openai_style([[1.0]]))
        with patch("urllib.request.urlopen") as urlopen, patch("time.sleep"):
            urlopen.side_effect = [RuntimeError("HTTP Error 503: Service Unavailable"), ok]
            got = provider.embed_query("hi")
        assert got == [1.0]
        assert urlopen.call_count == 2

    def test_does_not_retry_on_4xx_client_error(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        with patch("urllib.request.urlopen") as urlopen, pytest.raises(RuntimeError):
            urlopen.side_effect = RuntimeError("HTTP Error 401: Unauthorized")
            provider.embed_query("hi")
        assert urlopen.call_count == 1


class TestBatching:
    def test_embed_splits_into_100_sized_batches(self):
        provider = OpenAICompatEmbeddingProvider(
            base_url="http://fake/v1", model="fake-model"
        )
        calls = []

        def capture(req, timeout=None, context=None):
            body = json.loads(req.data)
            calls.append(len(body["input"]))
            return _fake_http_response(
                _openai_style([[float(i)] for i in range(len(body["input"]))])
            )

        with patch("urllib.request.urlopen", side_effect=capture):
            got = provider.embed([f"text-{i}" for i in range(250)])
        assert calls == [100, 100, 50]
        assert len(got) == 250


class TestEnvFactory:
    def test_returns_none_without_required_vars(self, monkeypatch):
        monkeypatch.delenv("CRG_OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("CRG_OPENAI_MODEL", raising=False)
        assert provider_from_env() is None

    def test_builds_with_env(self, monkeypatch):
        monkeypatch.setenv("CRG_OPENAI_BASE_URL", "http://localhost:11434/v1")
        monkeypatch.setenv("CRG_OPENAI_MODEL", "nomic-embed-text")
        monkeypatch.setenv("CRG_OPENAI_API_KEY", "optional-key")
        monkeypatch.setenv("CRG_OPENAI_DIMENSION", "768")
        p = provider_from_env()
        assert p is not None
        assert p._base_url == "http://localhost:11434/v1"
        assert p._model == "nomic-embed-text"
        assert p._api_key == "optional-key"
        assert p.dimension == 768

    def test_ignores_bogus_dimension(self, monkeypatch):
        monkeypatch.setenv("CRG_OPENAI_BASE_URL", "http://fake/v1")
        monkeypatch.setenv("CRG_OPENAI_MODEL", "m")
        monkeypatch.setenv("CRG_OPENAI_DIMENSION", "not-a-number")
        p = provider_from_env()
        assert p is not None
        # Dimension still unset — not pinned by env.
        assert p._dimension is None


class TestLoopbackDetection:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("http://localhost:11434/v1", True),
            ("http://127.0.0.1/v1", True),
            ("http://[::1]/v1", True),
            ("http://0.0.0.0/v1", True),
            ("https://api.openai.com/v1", False),
            ("http://ollama.my-office.internal/v1", False),
            ("", False),
            ("not-a-url", False),
        ],
    )
    def test_classification(self, url, expected):
        assert is_loopback_url(url) is expected


# ---------------------------------------------------------------------------
# Live test — opt-in. Skipped by default.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("CRG_LIVE_OPENAI_TEST") != "1",
    reason="Set CRG_LIVE_OPENAI_TEST=1 and CRG_OPENAI_BASE_URL to run live test",
)
def test_live_embed_query():
    """End-to-end against a real endpoint. Useful when debugging a provider.

    Example:
        CRG_LIVE_OPENAI_TEST=1 \\
        CRG_OPENAI_BASE_URL=http://localhost:11434/v1 \\
        CRG_OPENAI_MODEL=nomic-embed-text \\
        pytest -v -k test_live_embed_query
    """
    provider = provider_from_env()
    assert provider is not None, "Env not set; see docstring"
    vec = provider.embed_query("hello world")
    assert isinstance(vec, list) and len(vec) > 0
    assert all(isinstance(x, float) for x in vec[:10])
    assert provider.dimension == len(vec)
