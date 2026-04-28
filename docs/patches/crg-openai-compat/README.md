# Patch: OpenAI-compatible embedding provider for code-review-graph

Adds a new `OpenAICompatEmbeddingProvider` that speaks the OpenAI
`/v1/embeddings` wire protocol. Unlocks:

- **Ollama** (`http://localhost:11434/v1`, model `nomic-embed-text`)
- **LiteLLM / LocalAI**
- **Real OpenAI** (`text-embedding-3-small`/`-large`)
- Any private on-prem / air-gapped service that mimics OpenAI's schema
- Hubcode Desktop's in-process ONNX embedding server (bge-small-en-v1.5)

Target version: crg `>=2.3.2` (tested against 2.3.2 locally).

## Why

crg 2.3.2 ships three providers:

- `LocalEmbeddingProvider` — needs `sentence-transformers` (heavy optional dep)
- `GoogleEmbeddingProvider` — Gemini API
- `MiniMaxEmbeddingProvider` — MiniMax cloud

There is no way to point crg at an OpenAI-compatible HTTP endpoint, even
though it's the de facto standard for local inference servers. This patch
fills the gap without adding new dependencies (uses `urllib.request` like
`MiniMaxEmbeddingProvider`).

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `CRG_OPENAI_BASE_URL` | yes | — | e.g. `http://localhost:11434/v1` |
| `CRG_OPENAI_MODEL` | yes | — | e.g. `nomic-embed-text` |
| `CRG_OPENAI_API_KEY` | no | `""` | sent as `Authorization: Bearer …` if set |
| `CRG_OPENAI_DIMENSION` | no | probed | `1` first `embed_query` sets the value |
| `CRG_ACCEPT_CLOUD_EMBEDDINGS` | no | — | silences cloud-egress warning for non-localhost URLs |

Selection:

- Pass `provider="openai-compat"` to `get_provider()` or `EmbeddingStore(...)`.
- Or set `CRG_EMBEDDINGS_PROVIDER=openai-compat` and leave the arg `None`
  (the patch also wires env-driven default selection).

## Behavior details

- Cloud-egress warning: skipped automatically for `localhost` / `127.0.0.1` /
  `[::1]` hostnames. For remote endpoints, user must explicitly opt in via
  `CRG_ACCEPT_CLOUD_EMBEDDINGS=1`.
- Batching: mirrors `MiniMaxEmbeddingProvider` — 100 texts per HTTP request.
- Retry: 3 attempts with exponential backoff on `429`/`5xx`.
- Dimension: probed on first call (some models like Ollama's `nomic-embed-text`
  report variable dims); cached after. Explicit `CRG_OPENAI_DIMENSION` skips
  the probe.

## Files in this patch

- `embeddings_openai_compat.py` — new provider class (drop into `code_review_graph/`).
- `embeddings.patch` — minimal diff to `embeddings.py` (imports + `get_provider` dispatch + env default).
- `test_openai_compat_provider.py` — unit tests (mocked HTTP) + one live integration test (skipped unless `CRG_LIVE_OPENAI_TEST=1`).
- `CHANGES.md` — CHANGELOG entry for upstream PR.

## Applying

```bash
# 1. Copy the new provider into the crg source tree
cp embeddings_openai_compat.py <crg-src>/code_review_graph/

# 2. Apply the patch to embeddings.py
cd <crg-src>
git apply <path-to-this-folder>/embeddings.patch

# 3. Drop the test
cp test_openai_compat_provider.py <crg-src>/tests/

# 4. Run the test suite
pytest tests/test_openai_compat_provider.py -v
```

## Verify end-to-end with Hubcode

After publishing a patched crg (local wheel or fork):

```bash
pipx uninstall code-review-graph
pipx install /path/to/patched-crg-wheel
```

In Hubcode UI, select **"OpenAI-compatible"** for the workspace and fill:

- Base URL: `http://localhost:11434/v1` (Ollama)
- Model: `nomic-embed-text`
- API key: (leave blank)

Toggle indexing off+on. Then:

- `list_graph_stats_tool` should return `embeddings_count > 0`
- `semantic_search_nodes_tool` should return relevant hits

Same flow works for Hubcode Local by pointing base URL at the loopback
embedding server Hubcode already runs on start (see `embedding-server.ts`).
