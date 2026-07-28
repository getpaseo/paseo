# Custom OpenAI-compatible metadata endpoint — design

**Date:** 2026-07-28  
**Status:** Approved for implementation planning  
**Surface:** Daemon config + host settings UI (cross-device via connected clients)

## Problem

Paseo generates structured metadata with short internal LLM runs:

- commit messages
- pull request title/body
- workspace titles
- worktree branch names

Today that path always goes through coding-agent providers (Claude, Codex, etc.) resolved by `agents.metadataGeneration.providers` → built-in defaults → focused selection. That works, but:

1. There is **no host settings UI** for choosing which model does metadata work.
2. There is **no way** to point metadata generation at a plain OpenAI-compatible chat endpoint (local Ollama/LM Studio/vLLM, or hosted OpenRouter/OpenAI/Groq/etc.) without abusing full agent providers.
3. Speech `providers.openai` is STT/TTS-shaped and must not be overloaded for chat metadata.

Users who want cheap/local/hosted chat for short JSON tasks need an optional, daemon-scoped override.

## Goals

- Optional **custom OpenAI-compatible endpoint** for all structured metadata tasks.
- **Default off** — existing agent-based path unchanged when disabled.
- When enabled: **try custom first**, then fall through to the existing agent provider chain on failure.
- **Daemon-aware / host-scoped** so every device connected to that host sees and edits the same config.
- Minimal config: enable, base URL, API key, model.
- Model picker: **auto-discover** via `/v1/models` when possible; **free-text model** when discovery fails or the list is empty.
- Project `paseo.json` style instructions (`metadataGeneration.*.instructions`) keep working; only transport changes when custom endpoint is on.

## Non-goals (v1)

- Per-task enable toggles (commit vs PR vs title).
- Custom headers, non-standard URL paths, or multi-endpoint routing.
- Making the custom endpoint exclusive (no agent fallback).
- UI for the existing `agents.metadataGeneration.providers` preference list (file-only remains fine).
- Reusing speech `providers.openai` config for metadata.
- Project-scoped endpoint config in `paseo.json`.
- Full agent-provider registration for the custom endpoint (no tools/sessions/permissions).

## Current architecture (as-is)

```
Commit / PR / workspace title / branch name
  → buildMetadataPrompt (project style overrides from paseo.json)
  → resolveStructuredGenerationProviders (daemon preference list + defaults + focus)
  → generateStructuredAgentResponseWithFallback
       (internal non-persisted agent sessions per candidate provider)
  → validate JSON with Zod
  → product fallbacks on total failure (e.g. commit → "Update files")
```

Relevant code:

| Area                             | Location                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| Commit/PR generation             | `packages/server/src/server/session/checkout/git-metadata-generator.ts`  |
| Title/branch generation          | `packages/server/src/server/worktree-branch-name-generator.ts`           |
| Prompt + project style           | `packages/server/src/utils/build-metadata-prompt.ts`                     |
| Provider resolution              | `packages/server/src/server/agent/structured-generation-providers.ts`    |
| Structured agent fallback        | `packages/server/src/server/agent/agent-response-loop.ts`                |
| Project style schema             | `packages/protocol/src/paseo-config-schema.ts`                           |
| Daemon mutable config            | `packages/protocol/src/messages.ts` (`MutableDaemonConfigSchema`)        |
| Persist path                     | `$PASEO_HOME/config.json` via `daemon-config-store` / `persisted-config` |
| Host settings pattern            | `packages/app/src/screens/settings/host-page.tsx` + `useDaemonConfig`    |
| Project metadata UI (style only) | Project settings → Metadata generation                                   |

## Decisions

| Decision                | Choice                                                 | Why                                                           |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Approach                | Dedicated OpenAI-compatible HTTP client + host setting | Smaller than a fake agent provider; matches “short JSON task” |
| Default                 | Off                                                    | Zero behavior change for existing users                       |
| Failure mode            | Custom first, then existing agent chain                | Avoids bricking Commit/PR when local/hosted endpoint is down  |
| Task coverage           | All metadata structured-generation callers             | One pipeline, one toggle                                      |
| Scope                   | Daemon / host                                          | Runs where git + secrets live; works across devices           |
| Config vs speech OpenAI | Separate                                               | Different jobs and often different endpoints                  |
| Model UX                | Discover then free-text fallback                       | Works for Ollama and hosted gateways                          |

## Config shape

Persisted under `$PASEO_HOME/config.json`, nested with existing metadata preference config:

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [],
      "customEndpoint": {
        "enabled": false,
        "baseUrl": "",
        "apiKey": "",
        "model": ""
      }
    }
  }
}
```

| Field     | Type    | Default | Required when enabled | Notes                                                                                 |
| --------- | ------- | ------- | --------------------- | ------------------------------------------------------------------------------------- |
| `enabled` | boolean | `false` | —                     | Master switch                                                                         |
| `baseUrl` | string  | `""`    | yes                   | OpenAI-compatible root, e.g. `http://127.0.0.1:11434/v1`, `https://api.openai.com/v1` |
| `apiKey`  | string  | `""`    | no                    | Sent as `Authorization: Bearer …` when non-empty; optional for some local servers     |
| `model`   | string  | `""`    | yes                   | From discovery dropdown or free-text                                                  |

### Protocol / persistence rules

- Extend `agents.metadataGeneration` (persisted) and `MutableDaemonConfig.metadataGeneration` (RPC) with optional `customEndpoint`.
- All new fields optional; old clients/daemons must still parse (protocol backward-compat).
- Never put custom endpoint secrets in project `paseo.json`.
- Do not log raw API keys.
- When `enabled === true` but `baseUrl` or `model` is empty/whitespace: treat as misconfigured — **skip custom path**, log warning, fall through to agents.

### Suggested TypeScript shape

```ts
interface MetadataCustomEndpointConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

Empty strings are fine on the wire; normalization trims on read/use.

## Runtime architecture

Insert **one** pre-step at the shared structured-generation entry used by commit, PR, title, and branch generators. Do not fork each caller.

```
metadata task needs structured JSON
        │
        ▼
customEndpoint enabled + baseUrl + model present?
   no ──► existing agent provider chain (unchanged)
   yes
        │
        ▼
OpenAI-compatible chat completions
  POST {baseUrl}/chat/completions
  - model
  - messages built from existing metadata prompts
  - prefer JSON mode / schema if available;
    otherwise instruct JSON + Zod validate (same schemas as today)
  - short timeout, small max_tokens
        │
   success + schema valid ──► return
   fail ──► log warn (reason, no secrets)
              ──► existing agent provider chain
              ──► product fallbacks as today
```

### New server module (conceptual)

`metadata-openai-client` (name flexible; keep focused):

| Function                                                                     | Behavior                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `listModels({ baseUrl, apiKey })`                                            | `GET {baseUrl}/models` → normalized `{ id, name? }[]`; throws/returns error result on failure |
| `generateStructured({ baseUrl, apiKey, model, prompt, schema, schemaName })` | chat completions + extract content + Zod/AJV validate; retries limited (small, e.g. 1–2)      |

Not a full agent provider: no tools, no session persistence, no permissions UI.

### Integration point

Add a thin `generateStructuredMetadataResponse` (name flexible) that:

1. Tries the custom OpenAI-compatible client when config is complete and enabled.
2. On skip/failure, calls existing `generateStructuredAgentResponseWithFallback`.

Wire that helper from:

- `createAgentStructuredTextGeneration` (covers commit/PR via `GitMetadataGenerator`)
- `generateBranchNameFromFirstAgentContext` (covers workspace title + branch)

Do **not** bury custom-endpoint HTTP logic inside `generateStructuredAgentResponseWithFallback` — that function stays “try coding-agent providers in order.” Metadata transport ordering lives one layer above.

Callers keep building prompts and schemas the same way; only the transport order changes.

### HTTP details (v1)

- Join paths carefully: if `baseUrl` already ends with `/v1`, call `/chat/completions` and `/models` relative to that root without double-`/v1`.
- Request JSON body shape aligns with OpenAI chat completions.
- Response: read first choice message content; strip optional markdown fences; parse JSON; validate against the same Zod schemas already used (`CommitMessage`, `PullRequest`, `BranchName`, etc.).
- Timeouts: aggressive relative to coding agents (metadata should be seconds, not minutes). Exact values chosen at implementation; document in code.

## RPC

### Existing

- `get_daemon_config_request` / `response`
- `set_daemon_config_request` / `response` (patch)

Extend mutable config schemas so patch/get include `metadataGeneration.customEndpoint`.

### New (model discovery)

Dotted namespace with direction suffixes per `docs/rpc-namespacing.md`:

- `metadataGeneration.customEndpoint.listModels.request`
- `metadataGeneration.customEndpoint.listModels.response`

**Request (conceptual):**

```ts
{
  // Prefer explicit draft values from the settings form while editing;
  // if omitted, daemon may use saved customEndpoint config.
  baseUrl?: string;
  apiKey?: string;
}
```

**Response (conceptual):**

```ts
{
  models: Array<{ id: string; name?: string }>;
  error: null | { code: string; message: string };
}
```

Discovery failure is not a hard product error — UI falls back to free-text model input.

Capability: if needed, gate UI behind `server_info.features.*` with a `COMPAT(...)` comment; if the patch is shipped as a host+client pair for this fork, a single feature flag is still preferred over silent RPC failure.

## Host settings UI

**Where:** Host settings page (same area as auto-archive, terminal agent hooks, append system prompt) — **not** project settings.

**Card title (intent):** Metadata generation endpoint

| Control                | Behavior                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enable custom endpoint | Switch; default off. When off, dependent fields disabled/collapsed                                                                                                                               |
| Base URL               | Text field                                                                                                                                                                                       |
| API key                | Secure text; optional                                                                                                                                                                            |
| Model                  | After URL/key available: attempt discovery → dropdown. If discovery fails or empty: free-text model field remains usable. Optional “Refresh models” control if form UX needs an explicit trigger |
| Save                   | Existing `patchDaemonConfig`                                                                                                                                                                     |

**Copy (intent):**  
Optional OpenAI-compatible API for commit messages, PRs, workspace titles, and branch names. When off, Paseo uses your normal agent providers. When on, this endpoint is tried first; failures fall back to agents.

**Cross-device:** Any client connected to that host loads the same daemon config and can edit it.

**Project settings:** Keep “Metadata generation” style instruction fields as they are (branch/commit/PR wording). No endpoint fields there.

## Security

- Store API key only in daemon `config.json` on the host.
- Do not put keys in project config, client local storage, or analytics.
- List-models and generate only target the configured `baseUrl` (no open proxy).
- Redact secrets from daemon logs and error payloads returned to clients.
- Treat user-supplied baseUrl as untrusted network destination on the host machine (same class as any user-configured outbound URL on that host).

## Error handling

| Case                                             | Behavior                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Custom disabled                                  | Agent chain only                                                                      |
| Enabled but incomplete (`baseUrl`/`model` empty) | Skip custom, warn, agent chain                                                        |
| Network / HTTP / auth failure                    | Warn, agent chain                                                                     |
| Invalid JSON / schema validation failure         | Retry lightly if already doing so; then agent chain                                   |
| Agents also fail                                 | Existing product fallbacks (commit/PR stubs; title/branch may keep provisional title) |

User-facing Commit/PR flows should not fail solely because the custom endpoint is broken when agent fallback can still succeed.

## Testing

### Server unit

- Custom off → HTTP client never called; agent path used.
- Custom on + successful structured response → agent path not used.
- Custom on + HTTP/validation failure → agent path still runs.
- Enabled incomplete config → skip custom without throw.
- Config schema parse + patch round-trip for `customEndpoint`.
- `listModels` maps a normal OpenAI `/models` payload; failure yields empty/error result without crashing.

### Protocol

- Old configs without `customEndpoint` still parse.
- Mutable patch with only `customEndpoint` fields accepted.

### App

- Toggle off collapses/disables dependent fields.
- Discovery success populates model options.
- Discovery failure still allows free-text model save.
- Patch writes expected daemon config shape.

Prefer real local HTTP fixtures (mock server) over heavy mocks where practical; do not run full monorepo test suite — targeted vitest files only.

## Implementation sketch (not a plan)

1. Protocol + persisted schemas for `customEndpoint`.
2. Daemon config store merge/load.
3. OpenAI-compatible client module + unit tests.
4. Wire into structured metadata generation entry + fallthrough.
5. `listModels` RPC.
6. Host settings card + i18n.
7. Docs: `docs/data-model.md` note for the new block.

## Success criteria

- Default install: no behavior change for metadata generation.
- With custom endpoint configured and healthy: commit/PR/title/branch generation uses that endpoint without spawning coding-agent sessions.
- With custom endpoint broken: metadata still succeeds via agent fallback when agents work.
- Phone and desktop against the same host show the same setting and share the same endpoint config.
- Project style instructions still affect prompt wording regardless of transport.
