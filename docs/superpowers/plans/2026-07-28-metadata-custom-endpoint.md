# Custom OpenAI-Compatible Metadata Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, default-off, daemon-scoped OpenAI-compatible endpoint for all structured metadata generation (commit, PR, workspace title, branch), with host settings UI, model discovery + free-text fallback, and agent-provider fallthrough on failure.

**Architecture:** Extend daemon `metadataGeneration` config with `customEndpoint`. A thin HTTP client (`listModels` + `generateStructured`) runs first when enabled/complete. A new `generateStructuredMetadataResponse` wrapper tries that client, then existing `generateStructuredAgentResponseWithFallback`. Host settings card patches config via existing daemon config RPC; discovery uses a new dotted-namespace RPC.

**Tech Stack:** TypeScript, Zod schemas in `@getpaseo/protocol`, daemon config store, Vitest, React Native host settings (`useDaemonConfig`), native `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-28-metadata-custom-endpoint-design.md`

## Global Constraints

- Default: custom endpoint **off** — zero behavior change.
- When on: try custom first; on any failure fall through to existing agent chain; then product fallbacks.
- Covers **all** metadata tasks (commit, PR, title, branch) via one shared helper.
- Daemon/host scoped only — never project `paseo.json`.
- Separate from speech `providers.openai`.
- Minimal fields: `enabled`, `baseUrl`, `apiKey`, `model`.
- Model UX: discover via `GET {baseUrl}/models`; free-text when discovery fails/empty.
- Protocol backward-compatible: all new fields optional; old clients/daemons still parse.
- New RPCs use dotted namespaces with `.request`/`.response`.
- Never log raw API keys.
- Targeted tests only (`npx vitest run <file> --bail=1`); never full suite.
- After changes: `npm run typecheck`, `npm run lint` (or path-scoped), `npm run format` / format:files for touched paths.
- Rebuild stacks when cross-package types stale: `npm run build:client` / `npm run build:server` as needed.

## File map

| File                                                                    | Responsibility                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/messages.ts`                                     | Mutable daemon config `customEndpoint`; new listModels RPC schemas; `server_info.features.metadataCustomEndpoint` |
| `packages/protocol` tests                                               | Parse/patch/RPC acceptance                                                                                        |
| `packages/server/src/server/persisted-config.ts`                        | Persist `agents.metadataGeneration.customEndpoint`                                                                |
| `packages/server/src/server/daemon-config-store.ts`                     | Load/merge/patch customEndpoint into mutable + persisted config                                                   |
| `packages/server/src/server/agent/structured-generation-providers.ts`   | Extend `StructuredGenerationDaemonConfig` with customEndpoint                                                     |
| `packages/server/src/server/agent/metadata-openai-client.ts`            | HTTP client: URL join, listModels, generateStructured                                                             |
| `packages/server/src/server/agent/metadata-openai-client.test.ts`       | Client unit tests with mock HTTP                                                                                  |
| `packages/server/src/server/agent/generate-structured-metadata.ts`      | Wrapper: custom first → agent fallback                                                                            |
| `packages/server/src/server/agent/generate-structured-metadata.test.ts` | Fallthrough unit tests                                                                                            |
| `packages/server/src/server/session/checkout/git-metadata-generator.ts` | Use wrapper in `createAgentStructuredTextGeneration`                                                              |
| `packages/server/src/server/worktree-branch-name-generator.ts`          | Use wrapper instead of direct agent fallback                                                                      |
| `packages/server/src/server/session.ts`                                 | Handle listModels RPC; ensure config read includes customEndpoint                                                 |
| `packages/server/src/server/bootstrap.ts`                               | Initial mutable config includes customEndpoint                                                                    |
| `packages/server/src/server/websocket-server.ts`                        | Feature flag `metadataCustomEndpoint: true`                                                                       |
| `packages/client/src/daemon-client.ts`                                  | Client helper for listModels RPC                                                                                  |
| `packages/app/src/screens/settings/metadata-custom-endpoint-card.tsx`   | Host settings UI card                                                                                             |
| `packages/app/src/screens/settings/metadata-custom-endpoint-config.ts`  | Pure form/state helpers                                                                                           |
| `packages/app/src/screens/settings/metadata-custom-endpoint-*.test.ts`  | Pure helper + card logic tests                                                                                    |
| `packages/app/src/screens/settings/host-page.tsx`                       | Mount card                                                                                                        |
| `packages/app/src/i18n/resources/en.ts` (+ other locales as needed)     | Copy                                                                                                              |
| `docs/data-model.md`                                                    | Document config block                                                                                             |

---

### Task 1: Protocol + persisted schema for `customEndpoint`

**Files:**

- Modify: `packages/protocol/src/messages.ts` (`MutableStructuredGenerationProviderSchema` / `MutableMetadataGenerationConfigSchema` area ~126–190; `ServerInfoStatusPayloadSchema.features` ~2760+)
- Modify: `packages/server/src/server/persisted-config.ts` (`AgentMetadataGenerationSchema` ~168–172)
- Modify/extend: `packages/protocol/src/paseo-config-schema.test.ts` is project-style only — **do not** put customEndpoint there
- Modify: `packages/server/src/server/persisted-config.test.ts` (or add cases)
- Modify: existing protocol daemon-config tests if present; else add focused test next to messages tests

**Interfaces:**

- Produces:

```ts
// Protocol + persisted (same shape)
interface MetadataCustomEndpointConfig {
  enabled: boolean; // default false on mutable schema
  baseUrl: string; // default ""
  apiKey: string; // default ""
  model: string; // default ""
}

// MutableMetadataGenerationConfigSchema gains:
// customEndpoint: MetadataCustomEndpointSchema.default({ enabled: false, baseUrl: "", apiKey: "", model: "" })

// AgentMetadataGenerationSchema (persisted) gains:
// customEndpoint: z.object({ enabled?, baseUrl?, apiKey?, model? }).strict().optional()

// server_info.features.metadataCustomEndpoint?: boolean
// COMPAT(metadataCustomEndpoint): added 2026-07-28, remove after 2027-01-28
```

- [ ] **Step 1: Write failing protocol/persisted tests**

Add tests that:

1. `MutableDaemonConfigSchema` parses config with `metadataGeneration.customEndpoint` fully set.
2. Default mutable config yields `customEndpoint.enabled === false` and empty strings when omitted (via `.default`).
3. `MutableDaemonConfigPatchSchema` accepts partial `{ metadataGeneration: { customEndpoint: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1" } } }`.
4. Persisted config parse accepts `agents.metadataGeneration.customEndpoint`.
5. Old configs without `customEndpoint` still parse.
6. `ServerInfoStatusPayloadSchema` accepts `features.metadataCustomEndpoint: true` and still accepts without it.

- [ ] **Step 2: Run tests — expect fail**

```bash
npx vitest run packages/protocol/src/messages.ts packages/server/src/server/persisted-config.test.ts --bail=1
```

(If new test file, run that path.) Adjust command to the actual test file(s) you create.

- [ ] **Step 3: Implement schemas**

In `messages.ts`:

```ts
const MetadataCustomEndpointSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(""),
    apiKey: z.string().default(""),
    model: z.string().default(""),
  })
  .passthrough();

const MutableMetadataGenerationConfigSchema = z
  .object({
    providers: z.array(MutableStructuredGenerationProviderSchema).default([]),
    customEndpoint: MetadataCustomEndpointSchema.default({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: "",
    }),
  })
  .passthrough();
```

In `persisted-config.ts` extend `AgentMetadataGenerationSchema` with optional strict `customEndpoint` object (no forced defaults on disk — omit when unset is fine).

In `ServerInfoStatusPayloadSchema.features` add optional `metadataCustomEndpoint` with COMPAT comment.

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run <your-test-files> --bail=1
npm run build:client
```

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/server/src/server/persisted-config.ts packages/server/src/server/persisted-config.test.ts
git commit -m "feat(protocol): add metadataGeneration.customEndpoint schema"
```

---

### Task 2: Daemon config store load/merge for `customEndpoint`

**Files:**

- Modify: `packages/server/src/server/daemon-config-store.ts` (especially `mergeMutableConfigIntoPersistedConfig` ~260–355 and any load path that builds mutable config)
- Modify: `packages/server/src/server/bootstrap.ts` (`buildInitialMutableDaemonConfig` ~509–525)
- Modify: `packages/server/src/server/config.ts` if it maps persisted → runtime config for `metadataGeneration`
- Modify: `packages/server/src/server/daemon-config-store.test.ts`
- Modify: `packages/server/src/server/agent/structured-generation-providers.ts` — extend `StructuredGenerationDaemonConfig`

**Interfaces:**

- Produces:

```ts
// StructuredGenerationDaemonConfig
metadataGeneration?: {
  providers?: Array<{ provider: string; model?: string; thinkingOptionId?: string }>;
  customEndpoint?: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
};
```

- Mutable get/patch round-trips `customEndpoint`
- Persisted write includes `agents.metadataGeneration.customEndpoint` when present or when providers/customEndpoint already existed

- [ ] **Step 1: Write failing store tests**

Cases:

1. Load persisted config with customEndpoint → `store.get().metadataGeneration.customEndpoint` matches.
2. `store.patch({ metadataGeneration: { customEndpoint: { enabled: true, baseUrl: "http://x/v1", apiKey: "k", model: "m" } } })` persists under `agents.metadataGeneration.customEndpoint`.
3. Patching only `providers` does not wipe `customEndpoint` (deep merge).
4. Patching only `customEndpoint` does not wipe `providers`.
5. Initial bootstrap/mutable default has `enabled: false`.

- [ ] **Step 2: Run tests — expect fail**

```bash
npx vitest run packages/server/src/server/daemon-config-store.test.ts --bail=1
```

- [ ] **Step 3: Implement merge/read**

Add `readMetadataCustomEndpoint(mutable)` analogous to providers reader. Include in `persistedMetadataGeneration`:

```ts
const customEndpoint = readMetadataCustomEndpoint(mutable);
const persistedMetadataGeneration = {
  providers: metadataGenerationProviders,
  ...(customEndpoint ? { customEndpoint } : {}),
};
const shouldPersistMetadataGeneration =
  metadataGenerationProviders.length > 0 ||
  customEndpoint !== undefined ||
  persisted.agents?.metadataGeneration !== undefined;
```

Normalize strings with trim when reading for runtime use (store may keep raw; generation layer can normalize).

Update bootstrap initial config:

```ts
metadataGeneration: {
  providers: config.metadataGeneration?.providers ?? [],
  customEndpoint: {
    enabled: config.metadataGeneration?.customEndpoint?.enabled ?? false,
    baseUrl: config.metadataGeneration?.customEndpoint?.baseUrl ?? "",
    apiKey: config.metadataGeneration?.customEndpoint?.apiKey ?? "",
    model: config.metadataGeneration?.customEndpoint?.model ?? "",
  },
},
```

Ensure `config.ts` / load path surfaces customEndpoint from persisted agents block into whatever bootstrap reads.

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run packages/server/src/server/daemon-config-store.test.ts --bail=1
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/daemon-config-store.ts packages/server/src/server/daemon-config-store.test.ts packages/server/src/server/bootstrap.ts packages/server/src/server/config.ts packages/server/src/server/agent/structured-generation-providers.ts
git commit -m "feat(server): persist metadata custom endpoint in daemon config"
```

---

### Task 3: OpenAI-compatible metadata HTTP client

**Files:**

- Create: `packages/server/src/server/agent/metadata-openai-client.ts`
- Create: `packages/server/src/server/agent/metadata-openai-client.test.ts`

**Interfaces:**

- Produces:

```ts
export interface MetadataOpenAIClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // default 30_000
}

export interface MetadataOpenAIModel {
  id: string;
  name?: string;
}

export function joinOpenAICompatibleUrl(baseUrl: string, path: string): string;
// baseUrl may be "http://host:11434/v1" or "http://host:11434/v1/"
// path is "models" or "chat/completions" (no leading slash required)
// result never doubles /v1

export function isMetadataCustomEndpointReady(
  endpoint:
    | {
        enabled?: boolean;
        baseUrl?: string;
        model?: string;
      }
    | null
    | undefined,
): boolean;
// true only when enabled && trim(baseUrl) && trim(model)

export async function listMetadataOpenAIModels(input: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<
  | { models: MetadataOpenAIModel[]; error: null }
  | { models: []; error: { code: string; message: string } }
>;

export async function generateMetadataOpenAIStructured<T>(input: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number; // default 1 extra attempt after first failure
}): Promise<T>;
// throws Error on hard failure after retries
```

- [ ] **Step 1: Write failing unit tests with mock fetch**

Cover:

1. `joinOpenAICompatibleUrl("http://127.0.0.1:11434/v1", "models")` → `http://127.0.0.1:11434/v1/models`
2. Trailing slash baseUrl handled
3. `isMetadataCustomEndpointReady` false when disabled / empty baseUrl / empty model
4. `listMetadataOpenAIModels` maps `{ data: [{ id: "llama3" }, { id: "mistral", name?: ...}] }` → models array
5. listModels non-2xx → `{ models: [], error: { code, message } }` (no throw)
6. `generateMetadataOpenAIStructured` posts to chat/completions with Bearer when apiKey set; omits Authorization when empty
7. Parses message content JSON; validates Zod; returns typed object
8. Strips ```json fences if present
9. Invalid JSON / schema fail throws after retries
10. Timeout / network error throws
11. Request body includes instruction to return JSON only matching schemaName fields; prefer `response_format: { type: "json_object" }` when sending (many local servers ignore unknown fields — if a server rejects response_format, document retry without it OR only send json_object for known-good; simplest v1: send `response_format: { type: "json_object" }` and on 400 retry once without it)

Use `vi.fn` fetch; never hit network.

- [ ] **Step 2: Run tests — expect fail**

```bash
npx vitest run packages/server/src/server/agent/metadata-openai-client.test.ts --bail=1
```

- [ ] **Step 3: Implement client**

Implementation notes:

- Use `AbortSignal.timeout(timeoutMs)` or AbortController.
- Headers: `Content-Type: application/json`, optional `Authorization: Bearer ${apiKey}`.
- Chat body:

```ts
{
  model,
  temperature: 0,
  max_tokens: 1024,
  messages: [
    {
      role: "system",
      content:
        "You generate structured metadata for a developer tool. Reply with a single JSON object only. No markdown, no commentary.",
    },
    { role: "user", content: prompt },
  ],
  response_format: { type: "json_object" },
}
```

- Extract `choices[0].message.content` (string).
- `JSON.parse` after fence strip; `schema.parse`.
- Errors: include status text but never apiKey.

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run packages/server/src/server/agent/metadata-openai-client.test.ts --bail=1
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/metadata-openai-client.ts packages/server/src/server/agent/metadata-openai-client.test.ts
git commit -m "feat(server): add OpenAI-compatible metadata HTTP client"
```

---

### Task 4: `generateStructuredMetadataResponse` wrapper + wire callers

**Files:**

- Create: `packages/server/src/server/agent/generate-structured-metadata.ts`
- Create: `packages/server/src/server/agent/generate-structured-metadata.test.ts`
- Modify: `packages/server/src/server/session/checkout/git-metadata-generator.ts` (`createAgentStructuredTextGeneration`)
- Modify: `packages/server/src/server/worktree-branch-name-generator.ts`
- Modify existing tests if signatures need injection points:
  - `packages/server/src/server/session/checkout/git-metadata-generator.test.ts`
  - `packages/server/src/server/worktree-branch-name-generator.test.ts`

**Interfaces:**

```ts
export async function generateStructuredMetadataResponse<T>(options: {
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  manager: AgentManager;
  cwd: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  providers: StructuredGenerationProvider[];
  agentConfigOverrides: Partial<AgentSessionConfig> & { title?: string; internal?: boolean };
  persistSession?: boolean;
  maxRetries?: number;
  logger?: StructuredGenerationLogger & { warn?: ...; error?: ... };
  // test seams
  generateCustom?: typeof generateMetadataOpenAIStructured;
  generateWithAgents?: typeof generateStructuredAgentResponseWithFallback;
}): Promise<T>;
```

Behavior:

1. If `isMetadataCustomEndpointReady(daemonConfig?.metadataGeneration?.customEndpoint)`:
   - try `generateCustom` with trimmed baseUrl/apiKey/model
   - on success return
   - on failure `logger?.warn({ err, schemaName }, "Metadata custom endpoint failed; falling back to agents")` (no secrets)
2. Call `generateWithAgents` (default `generateStructuredAgentResponseWithFallback`) with same agent args

- [ ] **Step 1: Write failing wrapper tests**

1. custom off → only agent path called
2. custom incomplete → only agent path
3. custom on success → agent path not called; returns custom result
4. custom on throw → agent path called; returns agent result
5. both fail → throws agent error (StructuredAgentFallbackError)

- [ ] **Step 2: Run tests — expect fail**

```bash
npx vitest run packages/server/src/server/agent/generate-structured-metadata.test.ts --bail=1
```

- [ ] **Step 3: Implement wrapper**

- [ ] **Step 4: Wire `createAgentStructuredTextGeneration`**

Replace direct `generateStructuredAgentResponseWithFallback` with:

```ts
return generateStructuredMetadataResponse({
  daemonConfig: deps.readDaemonConfig(),
  manager: deps.agentManager,
  cwd,
  prompt,
  schema,
  schemaName,
  maxRetries: 2,
  providers,
  persistSession: false,
  agentConfigOverrides: {
    title: agentTitle,
    internal: true,
  },
});
```

- [ ] **Step 5: Wire `generateBranchNameFromFirstAgentContext`**

Same pattern after resolving providers; pass `daemonConfig: options.daemonConfig`.

Keep existing product fallbacks in commit/PR generators (catch StructuredAgent\*Error) — wrapper should rethrow agent fallback errors so those catches still work.

- [ ] **Step 6: Run targeted tests**

```bash
npx vitest run packages/server/src/server/agent/generate-structured-metadata.test.ts packages/server/src/server/session/checkout/git-metadata-generator.test.ts packages/server/src/server/worktree-branch-name-generator.test.ts --bail=1
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server/agent/generate-structured-metadata.ts packages/server/src/server/agent/generate-structured-metadata.test.ts packages/server/src/server/session/checkout/git-metadata-generator.ts packages/server/src/server/worktree-branch-name-generator.ts
git commit -m "feat(server): try custom metadata endpoint before agent providers"
```

---

### Task 5: listModels RPC + feature flag + client helper

**Files:**

- Modify: `packages/protocol/src/messages.ts` — inbound/outbound message schemas + `SessionInboundMessageSchema` / outbound unions
- Modify: `packages/server/src/server/session.ts` — dispatch handler
- Modify: `packages/server/src/server/websocket-server.ts` — `features.metadataCustomEndpoint: true` with COMPAT comment
- Modify: `packages/client/src/daemon-client.ts` — request helper
- Tests: protocol message parse tests; optional server unit if easy

**Interfaces:**

```ts
// Inbound
{
  type: "metadataGeneration.customEndpoint.listModels.request";
  requestId: string;
  baseUrl?: string;
  apiKey?: string;
}

// Outbound
{
  type: "metadataGeneration.customEndpoint.listModels.response";
  payload: {
    requestId: string;
    models: Array<{ id: string; name?: string }>;
    error: null | { code: string; message: string };
  };
}
```

Handler logic:

1. Resolve `baseUrl`/`apiKey` from request fields if provided (trim); else from `daemonConfigStore.get().metadataGeneration.customEndpoint`
2. If no baseUrl → respond `{ models: [], error: { code: "missing_base_url", message: "..." } }`
3. Else call `listMetadataOpenAIModels` and respond
4. Never echo apiKey in response

Client:

```ts
async listMetadataCustomEndpointModels(
  input: { baseUrl?: string; apiKey?: string } = {},
  requestId?: string,
): Promise<{ models: Array<{ id: string; name?: string }>; error: null | { code: string; message: string } }>
```

- [ ] **Step 1: Write protocol parse tests for request/response**

- [ ] **Step 2: Implement schemas + register in discriminated unions / codegen path**

If outbound messages go through zod-aot codegen (`packages/protocol/scripts/generate-validation-aot.mjs`), ensure new outbound type is included in the compile entry so generation succeeds. Run `npm run build:protocol` / `npm run build:client`.

- [ ] **Step 3: Session handler + feature flag**

- [ ] **Step 4: Client helper**

- [ ] **Step 5: Run tests + typecheck**

```bash
npx vitest run <protocol-test-file> --bail=1
npm run build:client
npm run typecheck --workspace=@getpaseo/protocol
npm run typecheck --workspace=@getpaseo/client
npm run typecheck --workspace=@getpaseo/server
```

- [ ] **Step 6: Commit**

```bash
git add packages/protocol packages/server/src/server/session.ts packages/server/src/server/websocket-server.ts packages/client
git commit -m "feat: add metadata custom endpoint listModels RPC"
```

---

### Task 6: Host settings UI card

**Files:**

- Create: `packages/app/src/screens/settings/metadata-custom-endpoint-config.ts`
- Create: `packages/app/src/screens/settings/metadata-custom-endpoint-config.test.ts`
- Create: `packages/app/src/screens/settings/metadata-custom-endpoint-card.tsx`
- Modify: `packages/app/src/screens/settings/host-page.tsx` (mount near auto-archive / terminal hooks / browser tools)
- Modify: `packages/app/src/i18n/resources/en.ts` (and mirror keys in other locale files if the repo requires parity — check `resources.test.ts`)
- Use: `useDaemonConfig`, `useHostRuntimeIsConnected`, `useHostRuntimeClient` for listModels

**Interfaces (pure config helpers):**

```ts
export function getMetadataCustomEndpointCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
  featureEnabled: boolean; // server_info.features.metadataCustomEndpoint
}): { isVisible: boolean };

export function readMetadataCustomEndpointFromConfig(config: MutableDaemonConfig | null): {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function createMetadataCustomEndpointPatch(input: {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}): MutableDaemonConfigPatch;

export function shouldShowModelFreeText(input: {
  discoveryStatus: "idle" | "loading" | "success" | "error";
  models: Array<{ id: string }>;
}): boolean;
// free text when error OR success with empty list OR idle without models — product: always allow free text field; dropdown when models.length > 0
```

**UI behavior:**

- Visible only when connected **and** `features.metadataCustomEndpoint` (COMPAT gate — one place).
- Switch Enable
- When enabled: show Base URL, API key, Model
- Model: if discovered models non-empty, show selectable list / dropdown pattern used elsewhere in settings; always keep ability to type custom model id (text input is fine if app lacks a generic combobox — prefer text input + optional list of pressable suggestions)
- “Refresh models” button calls client `listMetadataCustomEndpointModels` with **draft** baseUrl/apiKey
- Save button or autosave on switch like other cards:
  - Switch can patch enable immediately
  - For multi-field: follow Append System Prompt pattern (draft + Save) **or** patch on blur/save control. Prefer **draft + Save** for URL/key/model to avoid partial writes while typing; enable switch can still patch enable flag carefully.
  - Recommended UX matching design simplicity:
    1. Load draft from config when card mounts / config updates (don’t wipe in-progress draft on unrelated config ticks — key by serverId)
    2. Enable switch updates draft; if turning off, patch `{ enabled: false }` immediately keeping other fields
    3. Save patches full customEndpoint object

Copy (en):

- title: `Metadata generation endpoint`
- hint: `Optional OpenAI-compatible API for commit messages, PRs, workspace titles, and branch names. When off, Paseo uses your normal agent providers. When on, this endpoint is tried first; failures fall back to agents.`
- fields: Base URL, API key (optional), Model, Refresh models, Save

testIDs:

- `host-page-metadata-custom-endpoint-card`
- `host-page-metadata-custom-endpoint-switch`
- `host-page-metadata-custom-endpoint-base-url`
- `host-page-metadata-custom-endpoint-api-key`
- `host-page-metadata-custom-endpoint-model`
- `host-page-metadata-custom-endpoint-refresh-models`
- `host-page-metadata-custom-endpoint-save`

- [ ] **Step 1: Pure helper tests**

- [ ] **Step 2: Implement helpers + card + mount + i18n**

Feature gate source: host runtime snapshot / server info features — find how other cards gate (e.g. search `features?.workspaceFileEditing` in app). Use same pattern.

- [ ] **Step 3: Run app unit tests + typecheck**

```bash
npx vitest run packages/app/src/screens/settings/metadata-custom-endpoint-config.test.ts --bail=1
npm run typecheck --workspace=@getpaseo/app
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/screens/settings packages/app/src/i18n
git commit -m "feat(app): host settings for metadata custom endpoint"
```

---

### Task 7: Docs + final verification

**Files:**

- Modify: `docs/data-model.md` (section around `agents.metadataGeneration` ~189–207)

- [ ] **Step 1: Document config**

Update the config sketch:

```js
metadataGeneration: {
  providers: [{ provider, model?, thinkingOptionId? }],
  customEndpoint?: {
    enabled: boolean, // default false
    baseUrl: string,
    apiKey?: string,
    model: string
  }
}
```

Add prose:

- `customEndpoint` optional OpenAI-compatible chat endpoint tried before agent providers for commit/PR/title/branch metadata.
- Default off. Incomplete enabled config is skipped with a warning.
- Host settings UI configures this; project `paseo.json` only styles instructions.

- [ ] **Step 2: Run focused regression suite**

```bash
npx vitest run packages/server/src/server/agent/metadata-openai-client.test.ts packages/server/src/server/agent/generate-structured-metadata.test.ts packages/server/src/server/daemon-config-store.test.ts packages/server/src/server/session/checkout/git-metadata-generator.test.ts packages/server/src/server/worktree-branch-name-generator.test.ts packages/app/src/screens/settings/metadata-custom-endpoint-config.test.ts --bail=1
npm run typecheck
npm run lint
npm run format
```

- [ ] **Step 3: Commit**

```bash
git add docs/data-model.md
git commit -m "docs: document metadata custom endpoint config"
```

---

## Spec coverage checklist

| Spec requirement                     | Task                   |
| ------------------------------------ | ---------------------- |
| Optional default-off custom endpoint | 1, 2, 4                |
| Try custom then agents               | 4                      |
| All metadata tasks                   | 4 (git + branch/title) |
| Daemon-scoped config                 | 1, 2, 6                |
| Fields enabled/baseUrl/apiKey/model  | 1, 2, 6                |
| Model discovery + free-text          | 3, 5, 6                |
| Host settings UI                     | 6                      |
| Not project-scoped                   | 1, 6, 7                |
| Separate from speech OpenAI          | 3 (own client/config)  |
| listModels RPC dotted names          | 5                      |
| Feature flag COMPAT                  | 1, 5, 6                |
| No API key logs                      | 3, 4, 5                |
| Protocol back-compat                 | 1                      |
| data-model docs                      | 7                      |
| Tests listed in design               | 1–6                    |

## Self-review notes

- No exclusive-mode path (spec chose fallthrough).
- Integration is above `generateStructuredAgentResponseWithFallback`, not inside it.
- Secrets only in daemon config.
- No custom headers/paths in v1.
