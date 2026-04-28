# Changelog entry for upstream PR

## Added

- **OpenAI-compatible embedding provider** (`openai-compat`). Any server
  that speaks the OpenAI `/v1/embeddings` wire protocol can now be used as
  an embeddings backend. Works out of the box with:
  - **Ollama** (`nomic-embed-text`, `mxbai-embed-large`, etc.)
  - **LiteLLM / LocalAI**
  - **Real OpenAI** (`text-embedding-3-small` / `-large`)
  - On-prem / air-gapped inference sidecars

  Configuration via environment:

  - `CRG_OPENAI_BASE_URL` (required) — e.g. `http://localhost:11434/v1`
  - `CRG_OPENAI_MODEL` (required) — e.g. `nomic-embed-text`
  - `CRG_OPENAI_API_KEY` (optional) — passed as `Authorization: Bearer`
  - `CRG_OPENAI_DIMENSION` (optional) — pins output dim; probed otherwise

  Selection via code: `get_provider("openai-compat")` or
  `EmbeddingStore(..., provider="openai-compat")`.

  Selection via env: `CRG_EMBEDDINGS_PROVIDER=openai-compat` — `get_provider()`
  and `EmbeddingStore()` now default to whatever `CRG_EMBEDDINGS_PROVIDER`
  is set to when the caller passes `None`.

- **Cloud-egress warning suppressed automatically for loopback URLs**
  (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`). Remote endpoints still
  require explicit `CRG_ACCEPT_CLOUD_EMBEDDINGS=1`.

## Unchanged

- Default provider when nothing is configured remains `local`
  (sentence-transformers). No behavior change for existing users.
- `get_provider`'s signature is the same; only new branches + env fallback.

## Tests

- `tests/test_openai_compat_provider.py` covers happy path, retry,
  batching, env factory, loopback detection. Live test is opt-in via
  `CRG_LIVE_OPENAI_TEST=1`.

## Motivation

Several downstream integrations (Hubcode Desktop, Claude Code MCP bridges)
already run OpenAI-compatible inference sidecars for offline embeddings.
Without this provider, every one of them has to shell out to a second tool
or ship a patched crg. This unblocks the common case without adding
dependencies — the implementation is ~130 LOC using only `urllib.request`,
matching the style of `MiniMaxEmbeddingProvider`.
