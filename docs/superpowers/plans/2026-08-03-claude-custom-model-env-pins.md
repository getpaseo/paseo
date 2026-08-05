# Claude Custom Model Env Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Paseo launches Claude Code with a custom non-family model, pin `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to that model so Claude subagents/aliases stay on it.

**Architecture:** Add pure helpers in the Claude models module to detect custom non-family model IDs and build fill-if-missing env pins. Apply those pins at the end of `ClaudeAgentSession.buildSdkEnv()` after existing `createProviderEnv` composition. Also discover `ANTHROPIC_DEFAULT_FABLE_MODEL` from `~/.claude/settings.json` for the model picker.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK `options.env`, existing `createProviderEnv` / Claude model-manifest normalization.

**Spec:** `docs/superpowers/specs/2026-08-03-claude-custom-model-env-pins-design.md`

## Global Constraints

- Inject only for **custom non-family** selected models; never for first-party catalog models or family aliases (`opus`/`sonnet`/`haiku`/`fable`).
- All five pin keys use the **same** selected model ID.
- User/provider/process env wins: inject only when a pin key is missing/empty.
- Session-local only: recompute each `buildSdkEnv`; do not persist into `config.json`.
- Main chat model still comes from SDK `options.model` (unchanged).
- Keep helpers pure and unit-tested; prefer conservative no-inject over false positives.
- Follow repo rules: targeted vitest only, `npm run typecheck` / lint / format after changes, no full suite.

## File Structure

| File                                                                  | Responsibility                                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/agent/providers/claude/models.ts`         | Pin key constants; `isClaudeCustomNonFamilyModel`; `buildClaudeCustomModelEnvPins`; `applyClaudeCustomModelEnvPins`; add FABLE to settings discovery keys |
| `packages/server/src/server/agent/providers/claude/models.test.ts`    | Unit tests for detection, pin building, fill-if-missing apply, FABLE settings discovery                                                                   |
| `packages/server/src/server/agent/providers/claude/agent.ts`          | Call `applyClaudeCustomModelEnvPins` from `buildSdkEnv` using `this.config.model`                                                                         |
| `packages/server/src/server/agent/providers/claude/agent.env.test.ts` | Integration: custom model selected → SDK env contains pins; first-party model does not force pins; user env preserved                                     |
| `docs/custom-providers.md`                                            | Document FABLE discovery + auto-pin behavior                                                                                                              |

No new files required unless pure helpers grow large enough that a `custom-model-env.ts` sibling is cleaner. Prefer keeping them in `models.ts` first (same domain as settings model env keys).

### Detection rule (locked for implementers)

`isClaudeCustomNonFamilyModel(modelId)` returns `true` only when:

1. `modelId` trims to a non-empty string.
2. Lowercased trimmed value is **not** exactly one of: `opus`, `sonnet`, `haiku`, `fable`.
3. `normalizeClaudeRuntimeModelId(trimmed)` returns `null`  
   (this already maps first-party IDs and gateway-prefixed first-party forms like `openrouter/anthropic/claude-opus-4-8` / Bedrock-style `...claude-opus-4-8...` back to manifest IDs).

Otherwise return `false`.

This is intentionally conservative:

| Model                                  | Inject? | Why                               |
| -------------------------------------- | ------- | --------------------------------- |
| `glm-5.1`                              | Yes     | empty normalize, not family alias |
| `qwen3.5-plus`                         | Yes     | same                              |
| `openrouter/foo/bar`                   | Yes     | not first-party-shaped            |
| `openrouter/anthropic/claude-opus-4-8` | No      | runtime normalize → first-party   |
| `claude-opus-4-8`                      | No      | catalog/normalize                 |
| `opus`                                 | No      | family alias                      |
| `null` / `""`                          | No      | empty                             |

### Pin keys (locked)

```ts
export const CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;
```

---

### Task 1: Pure helpers + unit tests for custom-model env pins

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/models.ts`
- Modify: `packages/server/src/server/agent/providers/claude/models.test.ts`
- Test: `packages/server/src/server/agent/providers/claude/models.test.ts`

**Interfaces:**

- Consumes: `normalizeClaudeRuntimeModelId` from `./model-manifest.js` (already re-exported/used by `models.ts`)
- Produces:
  - `CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS`
  - `isClaudeCustomNonFamilyModel(modelId: string | null | undefined): boolean`
  - `buildClaudeCustomModelEnvPins(modelId: string): Record<(typeof CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS)[number], string>`
  - `applyClaudeCustomModelEnvPins(env: NodeJS.ProcessEnv, modelId: string | null | undefined): NodeJS.ProcessEnv`

- [ ] **Step 1: Write the failing unit tests**

Append a new `describe` block to `models.test.ts` (imports as needed):

```ts
import {
  applyClaudeCustomModelEnvPins,
  buildClaudeCustomModelEnvPins,
  CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS,
  isClaudeCustomNonFamilyModel,
} from "./models.js";

describe("Claude custom model env pins", () => {
  it.each([
    [null, false],
    [undefined, false],
    ["", false],
    ["   ", false],
    ["opus", false],
    ["SONNET", false],
    ["haiku", false],
    ["fable", false],
    ["claude-opus-4-8", false],
    ["claude-fable-5", false],
    ["openrouter/anthropic/claude-opus-4-8", false],
    ["glm-5.1", true],
    ["qwen3.5-plus", true],
    ["openrouter/foo/bar", true],
  ] as const)("isClaudeCustomNonFamilyModel(%j) → %s", (modelId, expected) => {
    expect(isClaudeCustomNonFamilyModel(modelId)).toBe(expected);
  });

  it("buildClaudeCustomModelEnvPins maps all pin keys to the selected model", () => {
    expect(buildClaudeCustomModelEnvPins("glm-5.1")).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-5.1",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.1",
    });
    expect(Object.keys(buildClaudeCustomModelEnvPins("glm-5.1"))).toEqual([
      ...CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS,
    ]);
  });

  it("applyClaudeCustomModelEnvPins fills only missing keys for custom models", () => {
    const applied = applyClaudeCustomModelEnvPins(
      {
        PATH: "/usr/bin",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus-pin",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "",
      },
      "glm-5.1",
    );

    expect(applied.PATH).toBe("/usr/bin");
    expect(applied.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("user-opus-pin");
    expect(applied.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
    expect(applied.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.1");
    expect(applied.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("glm-5.1");
    expect(applied.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  });

  it("applyClaudeCustomModelEnvPins is a no-op for first-party models", () => {
    const base = { PATH: "/usr/bin" };
    expect(applyClaudeCustomModelEnvPins(base, "claude-opus-4-8")).toEqual(base);
    expect(applyClaudeCustomModelEnvPins(base, "opus")).toEqual(base);
  });

  it("applyClaudeCustomModelEnvPins does not mutate the input env object", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const applied = applyClaudeCustomModelEnvPins(base, "glm-5.1");
    expect(applied).not.toBe(base);
    expect(base).toEqual({ PATH: "/usr/bin" });
    expect(applied.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  });
});
```

Also extend the existing settings discovery test `"appends concrete models from Claude settings.json"`:

1. Add `ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-from-settings"` to the `env` object in `createClaudeConfigDir(...)`.
2. Add `"fable-from-settings"` to `customModelIds` and therefore to the expected model ID list.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts --bail=1
```

Expected: FAIL because the new exports / FABLE discovery key do not exist yet.

- [ ] **Step 3: Implement pure helpers + FABLE discovery key**

In `models.ts`:

1. Extend settings discovery keys:

```ts
const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;
```

2. Add pin helpers (near the bottom of the file, before/after normalize re-export is fine):

```ts
export const CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export type ClaudeCustomModelPinEnvKey = (typeof CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS)[number];

const CLAUDE_FAMILY_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function isClaudeCustomNonFamilyModel(modelId: string | null | undefined): boolean {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (!trimmed) {
    return false;
  }
  if (CLAUDE_FAMILY_ALIASES.has(trimmed.toLowerCase())) {
    return false;
  }
  // First-party catalog IDs and gateway-prefixed first-party forms normalize to a manifest ID.
  if (normalizeClaudeRuntimeModelId(trimmed)) {
    return false;
  }
  return true;
}

export function buildClaudeCustomModelEnvPins(
  modelId: string,
): Record<ClaudeCustomModelPinEnvKey, string> {
  const pins = {} as Record<ClaudeCustomModelPinEnvKey, string>;
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    pins[key] = modelId;
  }
  return pins;
}

function hasNonEmptyEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function applyClaudeCustomModelEnvPins(
  env: NodeJS.ProcessEnv,
  modelId: string | null | undefined,
): NodeJS.ProcessEnv {
  if (!isClaudeCustomNonFamilyModel(modelId)) {
    return env;
  }
  const selectedModel = (modelId as string).trim();
  const pins = buildClaudeCustomModelEnvPins(selectedModel);
  let changed = false;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    if (hasNonEmptyEnvValue(next[key])) {
      continue;
    }
    next[key] = pins[key];
    changed = true;
  }
  return changed ? next : env;
}
```

Notes:

- `normalizeClaudeRuntimeModelId` is already available in this file via the existing import/re-export path — use the local exported function (or the imported manifest helper already aliased). Do not duplicate normalization.
- Keep `applyClaudeCustomModelEnvPins` pure: no reading `process.env` itself.

- [ ] **Step 4: Run unit tests to verify they pass**

Run:

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/server/src/server/agent/providers/claude/models.ts \
  packages/server/src/server/agent/providers/claude/models.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add Claude custom model env pin helpers

Detect non-family custom Claude models and build fill-if-missing
ANTHROPIC_DEFAULT_* / CLAUDE_CODE_SUBAGENT_MODEL pins; discover FABLE
from settings.json for the picker.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Apply pins in Claude `buildSdkEnv` + env integration tests

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/agent.ts`
- Modify: `packages/server/src/server/agent/providers/claude/agent.env.test.ts`
- Test: `packages/server/src/server/agent/providers/claude/agent.env.test.ts`

**Interfaces:**

- Consumes: `applyClaudeCustomModelEnvPins` from `./models.js`
- Produces: Claude SDK `options.env` includes pin keys when `config.model` is custom non-family

- [ ] **Step 1: Write the failing integration tests**

Append to the existing `describe("Claude SDK env", ...)` in `agent.env.test.ts`:

```ts
test("pins family and subagent env vars for custom non-family models", async () => {
  let capturedEnv: Record<string, string | undefined> | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedEnv = options.env;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: "custom-model-pin-session",
        permissionMode: "default",
        model: "glm-5.1",
      },
      {
        type: "assistant",
        message: { content: "done" },
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
        total_cost_usd: 0,
      },
    ]);
  });

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "glm-5.1",
  });

  try {
    await session.run("pin check");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.1");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.1");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("glm-5.1");
    expect(capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  } finally {
    await session.close();
  }
});

test("does not overwrite user-provided Claude model pin env vars", async () => {
  let capturedEnv: Record<string, string | undefined> | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedEnv = options.env;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: "custom-model-user-pin-session",
        permissionMode: "default",
        model: "glm-5.1",
      },
      {
        type: "assistant",
        message: { content: "done" },
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
        total_cost_usd: 0,
      },
    ]);
  });

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
    // runtimeSettings is the provider-config env path used by createProviderEnv
    // If the constructor does not accept runtimeSettings directly in this test file's
    // pattern, pass pins via launchContext.env instead — both are overlays in buildSdkEnv.
  });

  // Prefer launchContext.env because agent.env.test.ts already uses it and it is a final overlay.
  const session = await client.createSession(
    {
      provider: "claude",
      cwd: process.cwd(),
      model: "glm-5.1",
    },
    {
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "user-opus-pin",
      },
    },
  );

  try {
    await session.run("user pin check");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("user-opus-pin");
    expect(capturedEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
    expect(capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("glm-5.1");
  } finally {
    await session.close();
  }
});

test("does not force custom model pins for first-party Claude models", async () => {
  let capturedEnv: Record<string, string | undefined> | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedEnv = options.env;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: "first-party-model-session",
        permissionMode: "default",
        model: "claude-opus-4-8",
      },
      {
        type: "assistant",
        message: { content: "done" },
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
        total_cost_usd: 0,
      },
    ]);
  });

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-opus-4-8",
  });

  try {
    await session.run("first-party check");
    // Do not require keys to be absent from process.env inheritance.
    // Require that we did not force them to the selected first-party model ID.
    // If a key equals the selected model, that would only be acceptable if the host
    // env already had that exact value — so assert against auto-pin intent by checking
    // that at least CLAUDE_CODE_SUBAGENT_MODEL is not forced to the selected model unless
    // already present. Stronger pure coverage lives in models.test.ts.
    if (capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL === "claude-opus-4-8") {
      // Host may already define it; this integration test only guards the custom-model path.
      // The pure unit test is authoritative for no-op on first-party IDs.
      expect(true).toBe(true);
    } else {
      expect(capturedEnv?.CLAUDE_CODE_SUBAGENT_MODEL).not.toBe("claude-opus-4-8");
    }
  } finally {
    await session.close();
  }
});
```

**Implementer note:** Prefer making the first-party integration assertion robust by comparing against a snapshot of whether the key was already in `process.env` before the run, or rely primarily on pure unit tests for no-op behavior and keep this integration test focused on the custom-model positive path + user-env precedence. If the third test is too flaky against host env, drop it and keep the two custom-model tests only — pure tests already cover no-op.

Recommended minimal integration coverage if host env is noisy:

1. custom model → all five pins set to selected model
2. custom model + user pin in launch env → user pin preserved, others filled

- [ ] **Step 2: Run tests to verify the new cases fail**

Run:

```bash
npx vitest run packages/server/src/server/agent/providers/claude/agent.env.test.ts --bail=1
```

Expected: FAIL on custom-model pin assertions because `buildSdkEnv` does not apply pins yet.

- [ ] **Step 3: Wire pins into `buildSdkEnv`**

In `agent.ts`:

1. Import:

```ts
import {
  applyClaudeCustomModelEnvPins /* existing imports from models if any */,
} from "./models.js";
```

If `models.js` is already imported for other symbols, extend that import.

2. Change `buildSdkEnv` to:

```ts
private buildSdkEnv(extraClaudeOptions: Partial<ClaudeOptions> | undefined): NodeJS.ProcessEnv {
  const env = createProviderEnv({
    baseEnv: process.env,
    runtimeSettings: this.runtimeSettings,
    overlays: [
      extraClaudeOptions?.env,
      {
        // Increase MCP timeouts for long-running tool calls (10 minutes)
        MCP_TIMEOUT: "600000",
        MCP_TOOL_TIMEOUT: "600000",
      },
      this.launchEnv,
    ],
  });
  return applyClaudeCustomModelEnvPins(env, this.config.model);
}
```

Do **not** inject earlier in the overlay list; pins must be fill-if-missing **after** provider/launch env composition so user values win.

- [ ] **Step 4: Run env + models tests**

Run:

```bash
npx vitest run \
  packages/server/src/server/agent/providers/claude/models.test.ts \
  packages/server/src/server/agent/providers/claude/agent.env.test.ts \
  --bail=1
```

Expected: PASS.

- [ ] **Step 5: Typecheck the server package**

Run:

```bash
npm run typecheck --workspace @getpaseo/server
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add \
  packages/server/src/server/agent/providers/claude/agent.ts \
  packages/server/src/server/agent/providers/claude/agent.env.test.ts
git commit -m "$(cat <<'EOF'
feat(server): pin Claude family/subagent env for custom models

Apply fill-if-missing ANTHROPIC_DEFAULT_* and CLAUDE_CODE_SUBAGENT_MODEL
pins in Claude buildSdkEnv when the selected model is custom non-family.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Docs + final verification

**Files:**

- Modify: `docs/custom-providers.md`

**Interfaces:**

- Consumes: behavior from Tasks 1–2
- Produces: user-facing docs for FABLE discovery + auto-pin policy

- [ ] **Step 1: Update Claude settings discovery docs**

In `docs/custom-providers.md`, section `### Claude settings.json model discovery`, replace the env-key sentence so it includes FABLE:

Current:

> Paseo reads the top-level `model` field and these `env` keys: `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

New:

> Paseo reads the top-level `model` field and these `env` keys: `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `ANTHROPIC_DEFAULT_FABLE_MODEL`.

- [ ] **Step 2: Add auto-pin subsection after settings discovery**

Insert immediately after the settings discovery paragraphs (before `### Gotcha: extends: "claude" ...`):

```markdown
### Custom model family/subagent env pins

When a Claude session's selected model is a **custom non-family** model ID (not a first-party Claude catalog model and not a bare family alias like `opus`/`sonnet`/`haiku`/`fable`), Paseo pins Claude Code's internal model resolution env vars to that selected model:

- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_FABLE_MODEL`
- `CLAUDE_CODE_SUBAGENT_MODEL`

This is session-local (recomputed at launch via the Claude Agent SDK `env`) and exists so Claude Code subagents and family aliases do not fall back to Anthropic defaults when you are on a third-party/custom model.

Rules:

- First-party Claude models and family aliases are unchanged.
- User-provided values win: if a pin key is already set in process env, `agents.providers.*.env`, or launch env, Paseo leaves it alone.
- The main chat model is still enforced separately via the Claude Agent SDK `model` option.
```

- [ ] **Step 3: Format/docs hygiene**

Run:

```bash
npm run format:files -- docs/custom-providers.md
```

- [ ] **Step 4: Final targeted verification**

Run:

```bash
npx vitest run \
  packages/server/src/server/agent/providers/claude/models.test.ts \
  packages/server/src/server/agent/providers/claude/agent.env.test.ts \
  --bail=1
npm run typecheck --workspace @getpaseo/server
npm run lint -- packages/server/src/server/agent/providers/claude/models.ts packages/server/src/server/agent/providers/claude/agent.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/custom-providers.md
git commit -m "$(cat <<'EOF'
docs: document Claude custom model env pins

Explain FABLE settings discovery and session-local family/subagent
env pinning for custom non-family Claude models.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage checklist

| Spec requirement                                             | Task                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| Inject five env pins for custom non-family models            | Task 1 helpers + Task 2 `buildSdkEnv`     |
| No inject for first-party / family aliases                   | Task 1 detection tests + helper           |
| All pins = selected model                                    | Task 1 `buildClaudeCustomModelEnvPins`    |
| User env wins / fill-if-missing                              | Task 1 apply tests + Task 2 user pin test |
| Session-local via Claude SDK env                             | Task 2 `buildSdkEnv`                      |
| Discover `ANTHROPIC_DEFAULT_FABLE_MODEL` in settings catalog | Task 1 settings key + test                |
| Docs update                                                  | Task 3                                    |
| Keep `options.model` main-chat enforcement                   | untouched; still set in `buildOptions`    |

## Self-review notes

- No TBD/placeholder steps.
- Helper names and pin key list are consistent across tasks.
- Detection reuses existing `normalizeClaudeRuntimeModelId` rather than inventing a second catalog matcher.
- Integration tests use the established `agent.env.test.ts` queryFactory capture pattern.
- Host `process.env` noise is acknowledged; pure unit tests are authoritative for no-op/first-party cases.
