# Paseo Agent provider

Paseo Agent is the built-in agent provider that runs Pi's coding-agent harness **in
process** (no `pi` CLI, no `~/.pi` discovery). Its provider id is **`paseo`** and its
model backends are configured under `agents.paseo` in `$PASEO_HOME/config.json`.

Use it like any other agent provider:

```bash
paseo run --provider paseo --model <providerInstance>/<modelId> "Reply with pong"
```

Example: `--model openrouter/openai/gpt-4o-mini` selects the `openrouter` provider
instance and the `openai/gpt-4o-mini` model exposed by that instance.

> Smoke note: the daemon supervisor runs from `packages/server/dist`. After changing
> provider/config code, run `npm run build:server` (or run a source/dev daemon) before
> smoking, otherwise stale `dist` may reject or omit `agents.paseo` behavior. Always pass
> `--host <addr>` to CLI smoke commands so they hit your isolated daemon, not the real
> daemon on `:6767`.

## Timeline and persistence

Paseo Agent does not write or resume Pi CLI session files such as
`~/.pi/agent/sessions/*`; it runs Pi's harness in process and currently reports no
provider-owned session persistence. App refreshes and daemon-side agent reloads therefore
depend on Paseo's own timeline rows, not on a Pi history replay. Submitted prompts must be
emitted as `user_message` timeline rows when the turn starts; assistant text, reasoning,
and tool calls arrive later from Pi events and are mapped into the same Paseo timeline.

## Provider catalog

Paseo Agent model providers are catalog-driven, but Paseo does not copy Pi's provider
registry. `catalog.ts` is only the curated Paseo surface: catalog id, Pi provider id,
label, icon, default-model policy, and auth hints Pi cannot infer. Pi supplies the wire
API, base URL, headers, model ids, context windows, token limits, costs, reasoning flags,
thinking maps, and OAuth registry data at runtime.

The current catalog contains four entries:

| id            | Pi provider    | default models | auth source                                   |
| ------------- | -------------- | -------------- | --------------------------------------------- |
| `openrouter`  | `openrouter`   | none           | Paseo hint `OPENROUTER_API_KEY`               |
| `chatgpt`     | `openai-codex` | Pi full list   | Pi OAuth registry (`openai-codex`)            |
| `kimi`        | `kimi-coding`  | Pi full list   | Paseo hint `KIMI_API_KEY` (Pi has no env key) |
| `opencode-go` | `opencode-go`  | Pi full list   | Paseo hint `OPENCODE_API_KEY`                 |

OpenRouter intentionally has no default model because Pi's OpenRouter registry is large.
Users can store the OpenRouter credential first, but they must choose explicit model ids
before running Paseo Agent through that provider. The other catalog entries expose Pi's
bundled model list unless an instance sets `options.models`.

## Config shape

`agents.paseo.providers` is structurally generic. Provider instance names are free-form
keys; provider types are catalog ids. Use the catalog id as the default instance name,
or create several instances of the same type with different models, keys, or endpoint
overrides.

```jsonc
{
  "agents": {
    "paseo": {
      "defaultAgent": "orchestrator",
      "defaultModel": "openrouter-main/openai/gpt-4o-mini",
      "providers": {
        "openrouter-main": {
          "type": "openrouter",
          "options": {
            "apiKey": "$OPENROUTER_API_KEY",
            "models": [
              { "id": "openai/gpt-4o-mini", "label": "GPT-4o mini" },
              { "id": "anthropic/claude-3.7-sonnet", "reasoning": true },
            ],
          },
        },
        "chatgpt": {
          "type": "chatgpt",
        },
        "kimi": {
          "type": "kimi",
          "options": {
            "apiKey": "$KIMI_API_KEY",
            "models": [{ "id": "k2p7" }],
          },
        },
      },
    },
  },
}
```

Most options are overrides over Pi-derived provider data:

- `apiKey` may be omitted for API-key providers. Omitted means "use the derived or hinted
  env var", such as `OPENROUTER_API_KEY` or `KIMI_API_KEY`.
- `apiKey` may also be a literal key, `$ENV`, `${ENV}`, or `!command` expression. Paseo
  mirrors Pi's config-value semantics: literals and commands count as configured; env
  references count only when every referenced env var is set in the daemon environment.
- `baseUrl`, `api`, `headers`, and `authHeader` override or extend the Pi-derived request
  config.
- `models[]` is an instance override. Omit it to use that entry's default policy, which
  can be an empty list for catalog entries such as OpenRouter. A model may override `api`
  when a single backend serves mixed protocols or when Pi has no data for a custom id.
- `refreshToken` is an advanced OAuth seed path. Prefer the OAuth store described below.

Env references make config portable: `config.json` can be copied between machines while
the secret stays in that machine's daemon environment or keychain command.

`defaultModel` is optional and uses the same `<providerInstance>/<modelId>` form. An
explicit session model wins, then the selected agent definition's model, then
`agents.paseo.defaultModel`, then Pi's first available model.

`defaultProfile` is still accepted as a legacy alias for `defaultAgent`.

## Authentication

API-key providers use the catalog auth metadata plus the configured `apiKey` expression.
Redacted provider responses include an optional `auth` state:

- `Connected` means the key or credential expression resolves locally. It does not make a
  network call, so a fake literal key still reports connected until a real session uses it.
- `Needs attention` means the instance exists but the auth expression does not currently
  resolve, the OAuth store binding does not match, or another auth precondition is missing.
- `not configured` is used by older/no-auth responses.

The redacted provider `available` flag mirrors local credential availability. The Paseo
Agent runtime still needs at least one exposed model before it can start a session.

Secrets are not returned in catalog responses, redacted provider responses, or CLI table
output.

### OAuth store

OAuth credentials live in Paseo's store, not in another tool's auth file:

```text
$PASEO_HOME/paseo-agent/auth.json
```

The store is created through Pi's `AuthStorage`. The parent directory is private and the
file is written mode `0600`; Pi also re-chmods on write. During a Paseo Agent session,
Pi reads the credential, refreshes expired access tokens, and persists refresh-token
rotation back into the same Paseo-owned file.

Stored OAuth credentials are bound to the provider instance's `{ flow, baseUrl }`. If the
catalog flow or configured base URL changes, the old credential is left on disk but the
provider reports `Needs attention` until it is authorized again. This prevents a token
for one OAuth target from silently being used against another.

The OAuth implementation uses Pi's OAuth registry. Catalog OAuth entries are limited to
flows that registry knows about: `openai-codex`, `anthropic`, and `github-copilot`.
The current catalog only uses `openai-codex` for `chatgpt`.

## CLI setup

The provider CLI talks to the selected daemon. Always pass `--host` when smoking an
isolated daemon.

Commands:

- `paseo provider add [id]` configures a catalog provider. Omit `id` to choose from the
  daemon catalog. Use `--name`, repeated/comma-separated `--model`, `--api-key-stdin`,
  `--device-code`, `--json`, and `--host` as needed.
- `paseo provider ls` lists configured instances and redacted auth state.
- `paseo provider rm <name>` removes one provider instance and clears `defaultModel` if
  it pointed at that instance.

Examples:

```bash
printf '%s\n' "$OPENROUTER_API_KEY" |
  paseo provider add \
    openrouter \
    --api-key-stdin \
    --model openai/gpt-4o-mini \
    --host 127.0.0.1:7911
```

```bash
paseo provider add kimi \
  --model k2p7 \
  --host 127.0.0.1:7911
# Press Enter at the API-key prompt to store "$KIMI_API_KEY".
```

```bash
paseo provider add chatgpt --device-code --host 127.0.0.1:7911
```

Without an `[id]`, `provider add` prints the catalog and prompts for a selection. For
API-key providers it writes the configured key expression into `config.json`. For OAuth
providers it first writes the provider config, then stores the OAuth credential in the
daemon's Paseo-owned auth store.

`provider add` is idempotent for the same instance name: running it again updates the
existing entry instead of creating a duplicate. `provider rm <name>` removes only that
provider instance and clears `defaultModel` if it pointed at the removed instance.

## App setup

The app uses the same catalog and config RPCs as the CLI. In Settings, open the host
settings, then the Paseo Agent provider section. The app fetches the catalog from the
connected daemon, shows catalog entries in the picker, and renders either an API-key
form or an OAuth sign-in flow from the entry's `auth.kind`. OAuth providers offer two
daemon-run starts: browser redirect for the local fast path and device code for
remote-safe authorization. Relay connections present device code first; direct TCP does
not prove same-machine by itself, so both options remain available.

Configured rows show the redacted provider state from the daemon: label, provider type,
models, availability, and auth state. The app gates this UI on
`server_info.features.paseoAgentCatalog`; older daemons show an update-host affordance
instead of trying to synthesize the feature through older RPCs.

## Wire surface

The catalog surface is gated by:

```text
server_info.features.paseoAgentCatalog
```

RPC names use dotted namespaces:

| request                                             | response                                             |
| --------------------------------------------------- | ---------------------------------------------------- |
| `config.paseo_agent.get_catalog.request`            | `config.paseo_agent.get_catalog.response`            |
| `config.paseo_agent.get_providers.request`          | `config.paseo_agent.get_providers.response`          |
| `config.paseo_agent.set_provider.request`           | `config.paseo_agent.set_provider.response`           |
| `config.paseo_agent.remove_provider.request`        | `config.paseo_agent.remove_provider.response`        |
| `config.paseo_agent.oauth.start.request`            | `config.paseo_agent.oauth.start.response`            |
| `config.paseo_agent.oauth.complete.request`         | `config.paseo_agent.oauth.complete.response`         |
| `config.paseo_agent.oauth.store_credential.request` | `config.paseo_agent.oauth.store_credential.response` |

`oauth.start` accepts `mode?: string`; the daemon currently supports `"browser"` and
`"device_code"`, defaulting to `"browser"` because the common app/daemon desktop path can
complete the localhost redirect on the daemon host. Browser mode returns
`authorization: { kind: "auth_url", url, instructions? }` as soon as the daemon callback
listener is ready. `oauth.complete` then waits for the pending redirect flow to resolve,
stores the credential, and returns the redacted `auth` state. Device-code mode returns
`authorization: { kind: "device_code", userCode?, verificationUri?, intervalSeconds?,
expiresInSeconds?, instructions? }` and uses the same `oauth.complete` response after the
provider authorizes.

Protocol strings are intentionally open. Provider ids, auth kinds, OAuth flow names,
OAuth start modes, and wire API names are strings, not closed enums. Old clients can parse
new catalog entries, and new clients can show "update host" only when the daemon lacks the
catalog feature.

## Adding a catalog entry

Adding a new model-provider type should be a data change:

1. Add one entry to `PASEO_AGENT_PROVIDER_CATALOG` in
   `packages/server/src/server/agent/providers/paseo-agent/catalog.ts`.
2. Set `id`, `piProvider`, `label`, and `defaultModels: false` only when the Pi provider
   should not expose its full model list by default.
3. Add `auth` only when Pi cannot infer the auth source or when an explicit flow hint keeps
   resolution simple.
4. Add or update focused tests around catalog assembly, provider resolution, auth state,
   and CLI/app rendering if the new entry exercises a new shape.

Do not add provider-specific branches in the runtime, CLI, or app. The catalog entry is
what unlocks CLI setup, app setup, redacted provider state, config persistence, and model
addressing.

## MCP tools

Paseo Agent bridges `AgentSessionConfig.mcpServers` into Pi custom tools, so the
daemon-injected `paseo` MCP server (and any other configured MCP server) is available to
the model. On session start the provider connects to each server, lists its tools, and
registers them as Pi tools named `<serverName>__<toolName>`; tool input schemas (JSON
Schema) are converted to TypeBox, calls are proxied to the MCP server, and results map
back to the model. Connections are torn down on session close. Servers that fail to
connect or list are logged and skipped rather than failing the session.

Transports: HTTP (streamable) is the primary path (the injected `paseo` server is HTTP);
SSE and stdio transports are also wired via the MCP SDK. No extra config is needed: MCP
servers come from Paseo's normal injection/config, not from `agents.paseo`.

The internal `paseo` MCP server is required for Paseo Agent sessions and is injected even
when the global `mcp.injectIntoAgents` setting is disabled for other providers.

## Agent definitions

Paseo Agent can load a Paseo-owned agent definition from `$PASEO_HOME/agents/*.md`.
Configure the default agent in `agents.paseo.defaultAgent`; `orchestrator` resolves
to `$PASEO_HOME/agents/orchestrator.md`. Only top-level markdown files are selectable
agents. Reusable partials can live anywhere under `$PASEO_HOME/agents`.

```jsonc
{
  "agents": {
    "paseo": {
      "defaultAgent": "orchestrator",
      "defaultModel": "openrouter-main/openai/gpt-4o-mini",
      "providers": {},
    },
  },
}
```

Example `$PASEO_HOME/agents/orchestrator.md`:

```markdown
---
name: Orchestrator
description: Coordinates work through Paseo-managed agents
prompt: extend
mcp: [paseo]
model: openrouter-main/openai/gpt-4o-mini
tools: [read, grep, paseo__list_agents, paseo__create_agent]
permissions:
  - tool: paseo__archive_*
    action: deny
---

!{{./partials/collaboration.md}}

Use the Paseo MCP tools to inspect active agents, create focused helper agents, and
summarize handoffs clearly.

!{{./partials/review-rules.md}}
```

`prompt: extend` keeps Pi's default base prompt and prepends the composed agent body to
the append list. `prompt: override` uses the agent body as the custom base prompt, so
Pi's default base prompt is skipped. In both prompt modes, per-session `systemPrompt` is
appended after the agent, and the daemon-level append prompt is appended last.

Frontmatter supports `name`, `description`, `prompt`, `mcp`, `model`, `tools`,
`permissions`, and `projectContext`. `projectContext` is parsed for a future explicit
project-context model, but it does not activate implicit `AGENTS.md`/`CLAUDE.md`
discovery; Paseo Agent still keeps Pi context discovery off. `model` is an agent default:
an explicit session model wins, then the selected agent model, then
`agents.paseo.defaultModel`, then Pi's first available model.

Partials use bang braces and expand exactly where they appear: `!{{./partials/base.md}}`.
Paths are relative to the file containing the directive and are confined to
`$PASEO_HOME/agents`: absolute paths, directory escapes, cycles, overly deep partial
chains, oversized definitions, and frontmatter inside partials are rejected.

`tools` is the Pi tool allowlist for the agent: it controls what the model sees and can
call. Omit it to use Pi's default built-in tools plus bridged MCP tools. `permissions` is
an ordered first-match policy for active tool calls. The first matching `tool` pattern
wins; unmatched tools are allowed. Denied calls are blocked before execution through Pi's
tool preflight hook, so the policy applies to built-in, custom, and bridged MCP tools.

`mcp: [paseo]` is an expectation check, not a new injection mechanism. The normal daemon
MCP injection still supplies the actual server; if an agent declares an MCP server that
is not present in the session's `mcpServers`, Paseo Agent logs a warning and continues.
