# Claude Custom Model Env Pins Design

**Date:** 2026-08-03  
**Status:** Approved for implementation planning  
**Scope:** When Paseo launches Claude Code with a custom non-family model, also pin Claude Code family-alias and subagent model env vars so internal Claude resolution stays on that custom model.

## Problem

Paseo already enforces the **main** Claude session model via the Claude Agent SDK `options.model` field. That is enough for the parent chat.

It is **not** enough for Claude Code’s internal model resolution:

1. Family aliases (`opus`, `sonnet`, `haiku`, `fable`) resolve through `ANTHROPIC_DEFAULT_*_MODEL` env vars.
2. Subagents / agent teams / workflow agents resolve through `CLAUDE_CODE_SUBAGENT_MODEL` before falling back to invocation/frontmatter/main model.

Today, if a user selects a custom model such as `glm-5.1` (added via Paseo Settings or provider config):

- Parent chat uses `glm-5.1` ✅
- Claude-spawned subagents / alias resolution may still fall back to first-party Anthropic defaults ❌

Users of third-party Anthropic-compatible endpoints (Z.AI, Qwen, OpenRouter, Bedrock-style custom IDs, etc.) hit this whenever Claude Code tries to resolve a family alias or spawn a subagent.

## Goals

1. When the selected Claude model is a **custom non-family** model ID, pin these env vars to that selected model ID:
   - `ANTHROPIC_DEFAULT_OPUS_MODEL`
   - `ANTHROPIC_DEFAULT_SONNET_MODEL`
   - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
   - `ANTHROPIC_DEFAULT_FABLE_MODEL`
   - `CLAUDE_CODE_SUBAGENT_MODEL`
2. Leave first-party / built-in Claude models unchanged.
3. User-provided env always wins over auto-injection.
4. Use the Claude Agent SDK path Paseo already owns (`options.env` via `buildSdkEnv`).
5. Keep the change local, pure-helper-driven, and easy to unit test.

## Non-goals

- Mapping custom IDs into opus/sonnet/haiku/fable families based on name heuristics beyond “is this first-party/family or not.”
- Overwriting user/provider/process env that already sets any pin key.
- Changing UI for adding custom models.
- Changing protocol schemas.
- Auto-injecting for first-party Anthropic catalog models or family aliases (`opus`, `sonnet`, `haiku`, `fable`, `claude-*`).
- Replacing `options.model` enforcement for the main chat (it stays).
- Persisting auto-injected pins into `config.json`.

## Current behavior (baseline)

| Mechanism                                          | What it does today                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `options.model = config.model`                     | Forces main Claude session model                                                                                                 |
| `buildSdkEnv()` / `createProviderEnv()`            | Forwards process + provider + launch env overlays; does **not** derive model pins from selected model                            |
| `~/.claude/settings.json` discovery in `models.ts` | Adds catalog entries from `model` + `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` discovery          | Missing from settings catalog discovery                                                                                          |
| `CLAUDE_CODE_SUBAGENT_MODEL`                       | Only present if user/provider already set it (e.g. real e2e OpenRouter fixture)                                                  |

## Product decisions (locked)

| Decision                                         | Choice                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Approach                                         | Inject at Claude `buildSdkEnv` time (session-local)                      |
| Trigger                                          | Selected model is custom **and** non-family / non-built-in               |
| Values                                           | All five pin keys = selected model ID                                    |
| Precedence                                       | User/provider/process env wins; inject only missing keys                 |
| Built-in Claude models                           | No injection                                                             |
| Family aliases (`opus`/`sonnet`/`haiku`/`fable`) | No injection                                                             |
| Settings discovery completeness                  | Also discover `ANTHROPIC_DEFAULT_FABLE_MODEL` into catalog (picker only) |
| Persistence                                      | Do not write pins into config; recompute each launch                     |

## Trigger rule

Inject only when **all** of the following hold:

1. `config.model` is a non-empty string after trim.
2. After existing Claude runtime model normalization (including `[1m]` handling), the model is **not** present in the first-party Claude model catalog/manifest Paseo already ships.
3. The model ID is **not** a Claude family/built-in alias. Treat as family/built-in (no inject) when the normalized ID matches known first-party alias forms or clearly family-shaped Claude IDs, including:
   - exact aliases: `opus`, `sonnet`, `haiku`, `fable` (and any existing first-party alias forms Paseo already recognizes)
   - first-party IDs that contain Claude family markers such that they are clearly Anthropic catalog models (`claude-…`, `…opus…` / `…sonnet…` / `…haiku…` / `…fable…` in first-party form)

Conservative rule of thumb for implementation:

- Prefer **no injection** when the ID looks like a real Anthropic/first-party model or family alias.
- Prefer **injection** for clearly third-party IDs such as `glm-5.1`, `qwen3.5-plus`, gateway IDs that are not in the first-party catalog.

### Examples

| Selected model                                                 | Inject? |
| -------------------------------------------------------------- | ------- |
| `glm-5.1`                                                      | Yes     |
| `qwen3.5-plus`                                                 | Yes     |
| `openrouter/some-third-party/model` not in first-party catalog | Yes     |
| `claude-opus-4-8`                                              | No      |
| `claude-fable-5`                                               | No      |
| `opus` / `sonnet` / `haiku` / `fable`                          | No      |
| empty / null                                                   | No      |

## Injection values

When the trigger matches, set only **unset** keys to the selected model string:

```ts
{
  ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
  ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedModel,
  ANTHROPIC_DEFAULT_FABLE_MODEL: selectedModel,
  CLAUDE_CODE_SUBAGENT_MODEL: selectedModel,
}
```

No special-casing of subagent to haiku/inherit. Hard override via `CLAUDE_CODE_SUBAGENT_MODEL` is intentional.

## Precedence

Compose env exactly as today:

1. base `process.env`
2. provider runtime settings env (`agents.providers.*.env`)
3. extra Claude options env
4. fixed MCP timeout overlays
5. launch-context env

Then apply custom-model pins as a **final fill-if-missing** overlay:

- if key already has a non-empty string → keep
- else if injection active → set selected model

This preserves explicit user configuration while still fixing the default third-party case.

## Architecture

### Where

Claude provider only:

- pure helpers near Claude model utilities (`models.ts` / `model-manifest.ts` area)
- apply in `ClaudeAgentSession.buildSdkEnv()` in `providers/claude/agent.ts`

### Helpers

Suggested pure API (names flexible):

```ts
function isClaudeCustomNonFamilyModel(modelId: string | null | undefined): boolean;

function buildClaudeCustomModelEnvPins(
  modelId: string,
): Partial<Record<ClaudeModelPinEnvKey, string>>;

type ClaudeModelPinEnvKey =
  | "ANTHROPIC_DEFAULT_OPUS_MODEL"
  | "ANTHROPIC_DEFAULT_SONNET_MODEL"
  | "ANTHROPIC_DEFAULT_HAIKU_MODEL"
  | "ANTHROPIC_DEFAULT_FABLE_MODEL"
  | "CLAUDE_CODE_SUBAGENT_MODEL";
```

`buildSdkEnv` then:

1. build env via existing `createProviderEnv(...)`
2. if `isClaudeCustomNonFamilyModel(this.config.model)`:
   - for each pin key, if current env value is empty/undefined, set selected model

### Settings catalog completeness (small adjacent fix)

In `CLAUDE_SETTINGS_MODEL_ENV_KEYS` (`models.ts`), also include:

- `ANTHROPIC_DEFAULT_FABLE_MODEL`

This only affects **picker discovery** from `~/.claude/settings.json`. It does not itself inject env into sessions.

Do **not** add `CLAUDE_CODE_SUBAGENT_MODEL` to catalog discovery unless we later want that ID listed as a selectable model; subagent override is not a catalog model source.

## Data flow

```
selected model (config.model)
        │
        ▼
is custom non-family?
   no ──► env unchanged (main model still via options.model)
   yes
        ▼
compose provider env as today
        ▼
for each pin key:
  if unset → set to selected model
        ▼
Claude Agent SDK options.env
        ▼
Claude Code process:
  - main chat: options.model
  - family aliases: ANTHROPIC_DEFAULT_*
  - subagents: CLAUDE_CODE_SUBAGENT_MODEL
```

## Why the Claude Agent SDK path is correct

The Claude Agent SDK documents `options.env` as the Claude Code **subprocess environment** (replace semantics; Paseo already merges correctly via `createProviderEnv`).

Claude Code documents:

- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` for family alias pinning / third-party deployments
- `CLAUDE_CODE_SUBAGENT_MODEL` for subagent/team/workflow model override

No separate SDK “set subagent model” API is required for this goal.

## Tests

Prefer unit tests around pure helpers + Claude env construction:

1. Built-in first-party model selected → no pin keys added
2. Family alias selected (`opus` / `sonnet` / `haiku` / `fable`) → no pin keys added
3. Custom model `glm-5.1` selected → all five pin keys equal `glm-5.1`
4. Custom model + one pin key already set in provider env → that key preserved, others filled
5. Empty/null model → no injection
6. Settings discovery includes FABLE env key when present in settings.json
7. Existing launch-context env forwarding tests remain green

Use the existing Claude env test style in `agent.env.test.ts` / `models.test.ts`.

## Docs

Update `docs/custom-providers.md` Claude settings section:

1. Mention `ANTHROPIC_DEFAULT_FABLE_MODEL` in settings discovery keys.
2. Document auto-pin behavior:
   - custom non-family selected models pin the five env vars
   - user-provided env wins
   - first-party/family models are unchanged

## Implementation sketch (not the plan)

Likely touch points:

- `packages/server/src/server/agent/providers/claude/models.ts` — pin key constants, custom-model detection helpers, FABLE discovery key
- `packages/server/src/server/agent/providers/claude/model-manifest.ts` — reuse first-party membership/normalization if needed
- `packages/server/src/server/agent/providers/claude/agent.ts` — apply fill-if-missing pins in `buildSdkEnv`
- `packages/server/src/server/agent/providers/claude/models.test.ts` / `agent.env.test.ts` — coverage
- `docs/custom-providers.md` — user-facing docs

## Risks

| Risk                                      | Mitigation                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Over-injecting on first-party-looking IDs | Conservative detector; catalog membership first; no inject on family aliases                            |
| Overwriting intentional user pins         | Fill-if-missing only                                                                                    |
| Subagent override too aggressive          | Intentional product choice; document that `CLAUDE_CODE_SUBAGENT_MODEL` hard-overrides Claude resolution |
| SDK env replace semantics                 | Keep using `createProviderEnv` so PATH/HOME/auth vars remain intact                                     |
| Stale pins across model switches          | Recompute each `buildSdkEnv` from current `config.model`                                                |

## Success criteria

1. Selecting a custom non-family model in Paseo makes Claude Code subagents/aliases resolve to that same model ID via env pins.
2. Selecting a first-party Claude model does not add these env pins.
3. Explicit user/provider env for any pin key is preserved.
4. Main chat model enforcement via `options.model` remains unchanged.
5. Unit tests cover inject / no-inject / precedence cases.
6. Docs describe the behavior.

## Open implementation detail (plan can decide)

Exact string/heuristic for “family-shaped first-party ID” beyond catalog membership. Plan should reuse existing Claude normalization and catalog lookup first, then add the smallest alias/family guard needed so we do not inject on built-in models Paseo already shows.
