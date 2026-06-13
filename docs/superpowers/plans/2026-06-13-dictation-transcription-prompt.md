# Customizable Dictation Transcription Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit the dictation speech-to-text transcription prompt from the app's Host → Agents settings, persisted to `config.json`, instead of it being hardcoded / env-var-only.

**Architecture:** A flat `dictationTranscriptionPrompt` string is added to the client-editable `MutableDaemonConfig` (mirroring the existing `appendSystemPrompt`), bridged to `persisted.features.dictation.transcriptionPrompt`. The dictation manager reads the value (snapshotted from the live config store at session creation) and resolves `env > setting > built-in default` at each dictation start. The built-in default moves to a shared protocol constant so the app can show it as the textarea placeholder. The settings card is gated on a `serverInfo.features.dictationTranscriptionPrompt` capability flag and hidden on older daemons.

**Tech Stack:** TypeScript, Zod (protocol schemas), Node daemon, Expo/React Native app, vitest, i18next.

**Reference spec:** `docs/superpowers/specs/2026-06-13-dictation-transcription-prompt-design.md`

---

## Key conventions (read before starting)

- **Never run the full test suite.** Run only the specific changed file: `npx vitest run <file> --bail=1` (see per-task commands). Server tests run from `packages/server`, protocol from `packages/protocol`, app from `packages/app`.
- **Rebuild generated declarations after protocol changes** so dependent packages typecheck: `npm run build:client` (protocol + client). After server-type changes that other packages consume: `npm run build:server`.
- **After every code change run** `npm run typecheck` and `npm run lint -- <files>` from the repo root, and `npm run format` before committing.
- Field naming: top-level config field is `dictationTranscriptionPrompt`; persisted location is `features.dictation.transcriptionPrompt`; the `SessionOptions.dictation` sub-field is `transcriptionPrompt`.

---

## File structure

**Create:**

- `packages/protocol/src/dictation-prompt.ts` — shared `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT` constant (single source of truth for server fallback + app placeholder).

**Modify:**

- `packages/protocol/src/messages.ts` — mutable config field, patch field, capability flag.
- `packages/server/src/server/persisted-config.ts` — `FeatureDictationSchema.transcriptionPrompt`.
- `packages/server/src/server/config.ts` — resolve onto `PaseoDaemonConfig`.
- `packages/server/src/server/bootstrap.ts` — `PaseoDaemonConfig` interface field + `DaemonConfigStore` initial seed.
- `packages/server/src/server/daemon-config-store.ts` — mutable→persisted merge mapping.
- `packages/server/src/server/websocket-server.ts` — capability flag emission + dictation session option.
- `packages/server/src/server/session.ts` — `SessionOptions.dictation` type + pass-through to manager.
- `packages/server/src/server/dictation/dictation-stream-manager.ts` — constructor param + resolution + shared default.
- `packages/app/src/screens/settings/host-page.tsx` — `DictationPromptCard` + render in Agents section.
- `packages/app/src/i18n/resources/{en,es,fr,ru,ar,zh-CN}.ts` — `orchestration.dictationPrompt.*` keys.

**Test:**

- `packages/server/src/server/persisted-config.test.ts`
- `packages/protocol/src/messages.test.ts`
- `packages/server/src/server/daemon-config-store.test.ts`
- `packages/server/src/server/dictation/dictation-stream-manager.test.ts`

---

## Task 1: Shared default constant in the protocol package

**Files:**

- Create: `packages/protocol/src/dictation-prompt.ts`

- [ ] **Step 1: Create the constant file**

```ts
// packages/protocol/src/dictation-prompt.ts
// Single source of truth for the dictation transcription prompt default.
// Imported by the daemon (fallback when no custom prompt is set) and the app
// (shown as the settings textarea placeholder).
export const DEFAULT_DICTATION_TRANSCRIPTION_PROMPT =
  "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";
```

- [ ] **Step 2: Build the protocol package so the new subpath export resolves**

Run: `npm run build:client`
Expected: build succeeds; `packages/protocol/dist/dictation-prompt.js` and `.d.ts` exist.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/dictation-prompt.ts
git commit -m "feat(protocol): add shared dictation transcription prompt default"
```

---

## Task 2: Persisted config schema — `features.dictation.transcriptionPrompt`

**Files:**

- Modify: `packages/server/src/server/persisted-config.ts:89-102` (`FeatureDictationSchema`)
- Test: `packages/server/src/server/persisted-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `packages/server/src/server/persisted-config.test.ts` (place it near the other `features.dictation` tests, e.g. after the test around line 559):

```ts
it("round-trips features.dictation.transcriptionPrompt", () => {
  const parsed = PersistedConfigSchema.parse({
    version: 1,
    features: {
      dictation: {
        stt: { language: "en" },
        transcriptionPrompt: "Transcribe verbatim, keep filler words.",
      },
    },
  });
  expect(parsed.features?.dictation?.transcriptionPrompt).toBe(
    "Transcribe verbatim, keep filler words.",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/server`): `npx vitest run src/server/persisted-config.test.ts --bail=1`
Expected: FAIL — `transcriptionPrompt` is stripped (strict schema) or undefined.

- [ ] **Step 3: Add the field to `FeatureDictationSchema`**

In `packages/server/src/server/persisted-config.ts`, modify `FeatureDictationSchema` (currently lines 89-102) to add `transcriptionPrompt`:

```ts
const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    transcriptionPrompt: z.string().optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/server`): `npx vitest run src/server/persisted-config.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/server/src/server/persisted-config.ts packages/server/src/server/persisted-config.test.ts
git commit -m "feat(server): persist features.dictation.transcriptionPrompt"
```

---

## Task 3: Protocol — mutable config field, patch field, capability flag

**Files:**

- Modify: `packages/protocol/src/messages.ts:131-158` (`MutableDaemonConfigSchema` + `MutableDaemonConfigPatchSchema`) and `:2163-2178` (`ServerInfoStatusPayloadSchema.features`)
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/protocol/src/messages.test.ts` (append a new `describe` block; ensure `MutableDaemonConfigSchema` and `ServerInfoStatusPayloadSchema` are imported from `./messages.js` at the top of the file — add them to the existing import if missing):

```ts
describe("dictationTranscriptionPrompt", () => {
  it("defaults dictationTranscriptionPrompt to empty string", () => {
    const parsed = MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: true } });
    expect(parsed.dictationTranscriptionPrompt).toBe("");
  });

  it("preserves a provided dictationTranscriptionPrompt", () => {
    const parsed = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      dictationTranscriptionPrompt: "Keep filler words.",
    });
    expect(parsed.dictationTranscriptionPrompt).toBe("Keep filler words.");
  });

  it("accepts the capability flag and parses payloads without it", () => {
    const withFlag = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "s1",
      features: { dictationTranscriptionPrompt: true },
    });
    expect(withFlag.features?.dictationTranscriptionPrompt).toBe(true);

    const withoutFlag = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "s1",
    });
    expect(withoutFlag.features?.dictationTranscriptionPrompt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/protocol`): `npx vitest run src/messages.test.ts --bail=1`
Expected: FAIL — `dictationTranscriptionPrompt` is undefined / flag stripped.

- [ ] **Step 3: Add the mutable config field**

In `packages/protocol/src/messages.ts`, modify `MutableDaemonConfigSchema` (lines 131-144) to add the field after `appendSystemPrompt`:

```ts
export const MutableDaemonConfigSchema = z
  .object({
    mcp: z
      .object({
        injectIntoAgents: z.boolean(),
      })
      .passthrough(),
    providers: z.record(z.string(), MutableDaemonProviderConfigSchema).default({}),
    metadataGeneration: MutableMetadataGenerationConfigSchema.default({ providers: [] }),
    autoArchiveAfterMerge: z.boolean().default(false),
    appendSystemPrompt: z.string().default(""),
    // COMPAT(dictationTranscriptionPrompt): added in v0.1.96, remove gate after 2026-12-13.
    dictationTranscriptionPrompt: z.string().default(""),
    terminalProfiles: z.array(TerminalProfileSchema).optional(),
  })
  .passthrough();
```

- [ ] **Step 4: Add the patch field**

Modify `MutableDaemonConfigPatchSchema` (lines 146-158) to add the optional field after `appendSystemPrompt`:

```ts
export const MutableDaemonConfigPatchSchema = z
  .object({
    mcp: MutableDaemonConfigSchema.shape.mcp.partial().optional(),
    providers: z
      .record(z.string(), MutableDaemonProviderConfigSchema.partial().passthrough())
      .optional(),
    metadataGeneration: MutableMetadataGenerationConfigSchema.partial().optional(),
    autoArchiveAfterMerge: z.boolean().optional(),
    appendSystemPrompt: z.string().optional(),
    dictationTranscriptionPrompt: z.string().optional(),
    terminalProfiles: z.array(TerminalProfileSchema).optional(),
  })
  .partial()
  .passthrough();
```

- [ ] **Step 5: Add the capability flag**

Modify `ServerInfoStatusPayloadSchema.features` (lines 2163-2178) to add the flag inside the `features` object (after `checkoutRefresh`):

```ts
        // COMPAT(checkoutRefresh): added in v0.1.86, remove gate after 2026-11-29.
        checkoutRefresh: z.boolean().optional(),
        // COMPAT(dictationTranscriptionPrompt): added in v0.1.96, remove gate after 2026-12-13.
        dictationTranscriptionPrompt: z.boolean().optional(),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `packages/protocol`): `npx vitest run src/messages.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 7: Rebuild protocol declarations, typecheck, commit**

```bash
npm run build:client
npm run typecheck
npm run format
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add dictationTranscriptionPrompt config field and capability flag"
```

---

## Task 4: Resolve onto `PaseoDaemonConfig` and seed the config store

**Files:**

- Modify: `packages/server/src/server/bootstrap.ts:232-254` (`PaseoDaemonConfig` interface) and `:301-322` (`DaemonConfigStore` initial seed)
- Modify: `packages/server/src/server/config.ts:319-338` (`resolveStaticLoadConfigSettings`) and `:351-390` (`loadConfig` destructure + return)

This task is pure wiring (verified by typecheck/build, not a unit test).

- [ ] **Step 1: Add the field to the `PaseoDaemonConfig` interface**

In `packages/server/src/server/bootstrap.ts`, add after `appendSystemPrompt?: string;` (line 242):

```ts
  appendSystemPrompt?: string;
  dictationTranscriptionPrompt?: string;
```

- [ ] **Step 2: Resolve the persisted value in `config.ts`**

In `packages/server/src/server/config.ts`, add to the object returned by `resolveStaticLoadConfigSettings` (after the `appendSystemPrompt` line ~329):

```ts
    appendSystemPrompt: resolveAppendSystemPrompt(persisted),
    dictationTranscriptionPrompt: persisted.features?.dictation?.transcriptionPrompt ?? "",
```

- [ ] **Step 3: Thread it through `loadConfig`**

In `loadConfig`, add `dictationTranscriptionPrompt` to the destructure of `resolveStaticLoadConfigSettings(...)` (after `appendSystemPrompt,` ~line 355):

```ts
    autoArchiveAfterMerge,
    appendSystemPrompt,
    dictationTranscriptionPrompt,
    terminalProfiles,
```

and add it to the returned `PaseoDaemonConfig` object (after `appendSystemPrompt,` ~line 389):

```ts
    appendSystemPrompt,
    dictationTranscriptionPrompt,
```

- [ ] **Step 4: Seed the `DaemonConfigStore` initial value in `bootstrap.ts`**

In `packages/server/src/server/bootstrap.ts`, add to the initial config object passed to `new DaemonConfigStore(...)` (after the `appendSystemPrompt` line 318):

```ts
      appendSystemPrompt: config.appendSystemPrompt ?? "",
      dictationTranscriptionPrompt: config.dictationTranscriptionPrompt ?? "",
```

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/server/src/server/bootstrap.ts packages/server/src/server/config.ts
git commit -m "feat(server): resolve dictationTranscriptionPrompt into daemon config"
```

---

## Task 5: Bridge mutable config → persisted config on save

**Files:**

- Modify: `packages/server/src/server/daemon-config-store.ts:203-218` (`mergeMutableConfigIntoPersistedConfig` return)
- Test: `packages/server/src/server/daemon-config-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/server/daemon-config-store.test.ts` (mirror the existing `appendSystemPrompt` persistence test around lines 124-141; `DaemonConfigStore` and `loadPersistedConfig` are already imported there):

```ts
it("persists dictationTranscriptionPrompt to features.dictation", () => {
  const store = new DaemonConfigStore(
    paseoHome,
    {
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      appendSystemPrompt: "",
      dictationTranscriptionPrompt: "",
    },
    logger,
  );

  store.patch({ dictationTranscriptionPrompt: "Keep filler words." });

  const persisted = loadPersistedConfig(paseoHome);
  expect(persisted.features?.dictation?.transcriptionPrompt).toBe("Keep filler words.");
});
```

> Note: use the same `paseoHome` / `logger` fixtures the surrounding tests use (check the top of the existing test file — typically a temp dir created in `beforeEach`). Match the exact local variable names already in scope.

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/server`): `npx vitest run src/server/daemon-config-store.test.ts --bail=1`
Expected: FAIL — `persisted.features` is undefined (no mapping yet).

- [ ] **Step 3: Add the mapping to the merge function**

In `packages/server/src/server/daemon-config-store.ts`, modify the `return` object of `mergeMutableConfigIntoPersistedConfig` (lines 203-218) to add a `features` mapping:

```ts
return {
  ...persisted,
  daemon: {
    ...persisted.daemon,
    mcp: {
      ...persisted.daemon?.mcp,
      injectIntoAgents: mutable.mcp.injectIntoAgents,
    },
    autoArchiveAfterMerge: mutable.autoArchiveAfterMerge,
    appendSystemPrompt: mutable.appendSystemPrompt,
    ...(mutable.terminalProfiles !== undefined
      ? { terminalProfiles: mutable.terminalProfiles }
      : {}),
  },
  features: {
    ...persisted.features,
    dictation: {
      ...persisted.features?.dictation,
      transcriptionPrompt: mutable.dictationTranscriptionPrompt,
    },
  },
  agents: nextAgents,
} as PersistedConfig;
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/server`): `npx vitest run src/server/daemon-config-store.test.ts --bail=1`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/server/src/server/daemon-config-store.ts packages/server/src/server/daemon-config-store.test.ts
git commit -m "feat(server): map dictationTranscriptionPrompt into persisted config"
```

---

## Task 6: Dictation manager — constructor param, shared default, resolution precedence

**Files:**

- Modify: `packages/server/src/server/dictation/dictation-stream-manager.ts` (imports line 1-15; class fields ~128-136; constructor 138-157; `handleStart` 174-176)
- Test: `packages/server/src/server/dictation/dictation-stream-manager.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/server/src/server/dictation/dictation-stream-manager.test.ts`:

First, extend the existing `FakeSttProvider` (lines 54-64) to record the prompt — add the field and assignment:

```ts
class FakeSttProvider implements SpeechToTextProvider {
  public readonly id = "fake";
  public lastLanguage?: string;
  public lastPrompt?: string;
  constructor(private readonly session: FakeRealtimeSession) {}
  createSession(
    params: Parameters<SpeechToTextProvider["createSession"]>[0],
  ): StreamingTranscriptionSession {
    this.lastLanguage = params.language;
    this.lastPrompt = params.prompt;
    return this.session;
  }
}
```

Then add this new `describe` block (and add `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT` to the imports: `import { DEFAULT_DICTATION_TRANSCRIPTION_PROMPT } from "@getpaseo/protocol/dictation-prompt";`):

```ts
describe("DictationStreamManager (transcription prompt resolution)", () => {
  const ENV_KEY = "PASEO_DICTATION_TRANSCRIPTION_PROMPT";
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  const startManager = async (transcriptionPrompt?: string) => {
    const session = new FakeRealtimeSession();
    const provider = new FakeSttProvider(session);
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: () => {},
      sessionId: "s1",
      stt: provider,
      transcriptionPrompt,
    });
    await manager.handleStart("d1", "audio/pcm;rate=24000;bits=16");
    manager.cleanupAll();
    return provider;
  };

  it("uses the configured prompt when set", async () => {
    const provider = await startManager("Custom dictation prompt.");
    expect(provider.lastPrompt).toBe("Custom dictation prompt.");
  });

  it("falls back to the shared default when no prompt configured", async () => {
    const provider = await startManager(undefined);
    expect(provider.lastPrompt).toBe(DEFAULT_DICTATION_TRANSCRIPTION_PROMPT);
  });

  it("lets the env var override the configured prompt", async () => {
    process.env[ENV_KEY] = "Env override prompt.";
    const provider = await startManager("Custom dictation prompt.");
    expect(provider.lastPrompt).toBe("Env override prompt.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/server`): `npx vitest run src/server/dictation/dictation-stream-manager.test.ts --bail=1`
Expected: FAIL — constructor rejects `transcriptionPrompt` / default literal differs / type error.

- [ ] **Step 3: Import the shared default**

In `packages/server/src/server/dictation/dictation-stream-manager.ts`, add to the imports (after line 15):

```ts
import { DEFAULT_DICTATION_TRANSCRIPTION_PROMPT } from "@getpaseo/protocol/dictation-prompt";
```

- [ ] **Step 4: Add the field and constructor param**

Add a class field (near line 133, after `private readonly language: string;`):

```ts
  private readonly language: string;
  private readonly transcriptionPrompt?: string;
```

Add to the constructor param type (after `language?: string;`, line 143) and assign it (after `this.language = ...`, line 151):

```ts
    language?: string;
    transcriptionPrompt?: string;
```

```ts
this.language = params.language ?? "en";
this.transcriptionPrompt = params.transcriptionPrompt;
```

- [ ] **Step 5: Use the resolution chain in `handleStart`**

Replace the inline default (lines 174-176) with:

```ts
const transcriptionPrompt =
  process.env.PASEO_DICTATION_TRANSCRIPTION_PROMPT ??
  this.transcriptionPrompt ??
  DEFAULT_DICTATION_TRANSCRIPTION_PROMPT;
```

- [ ] **Step 6: Run the test to verify it passes**

Run (from `packages/server`): `npx vitest run src/server/dictation/dictation-stream-manager.test.ts --bail=1`
Expected: PASS (all describe blocks in the file).

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/server/src/server/dictation/dictation-stream-manager.ts packages/server/src/server/dictation/dictation-stream-manager.test.ts
git commit -m "feat(server): resolve dictation prompt from env > setting > shared default"
```

---

## Task 7: Thread the configured prompt through the Session

**Files:**

- Modify: `packages/server/src/server/session.ts:616-621` (`SessionOptions.dictation` type) and `:1328-1335` (`DictationStreamManager` construction)

Pure wiring (verified by typecheck + the manager test already proving consumption).

- [ ] **Step 1: Add `transcriptionPrompt` to the `SessionOptions.dictation` type**

In `packages/server/src/server/session.ts`, modify the `dictation` field of `SessionOptions` (lines 616-621):

```ts
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    transcriptionPrompt?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
```

- [ ] **Step 2: Pass it to the manager**

Modify the `DictationStreamManager` construction (lines 1328-1335) to pass the prompt:

```ts
this.dictationStreamManager = new DictationStreamManager({
  logger: this.sessionLogger,
  sessionId: this.sessionId,
  emit: (msg) => this.handleDictationManagerMessage(msg),
  stt: dictation?.stt ?? null,
  language: dictation?.sttLanguage,
  transcriptionPrompt: dictation?.transcriptionPrompt,
  finalTimeoutMs: dictation?.finalTimeoutMs,
});
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/server/src/server/session.ts
git commit -m "feat(server): pass dictation transcription prompt into the session manager"
```

---

## Task 8: Emit the capability flag and supply the prompt from the live config store

**Files:**

- Modify: `packages/server/src/server/websocket-server.ts:953-961` (dictation session options) and `:1092-1106` (features block)

Pure wiring (verified by typecheck + build).

- [ ] **Step 1: Emit the capability flag**

In `packages/server/src/server/websocket-server.ts`, add to the `features` object in `buildServerInfoStatusPayload` (after `checkoutRefresh: true,` line 1105):

```ts
        // COMPAT(checkoutRefresh): added in v0.1.86, remove gate after 2026-11-29.
        checkoutRefresh: true,
        // COMPAT(dictationTranscriptionPrompt): added in v0.1.96, remove gate after 2026-12-13.
        dictationTranscriptionPrompt: true,
```

- [ ] **Step 2: Supply the prompt to the dictation session options (session snapshot from the live store)**

Modify the `dictation` session option (lines 953-961) to read the current store value when the session is created. Empty string normalizes to `undefined` so the manager falls back to the default:

```ts
      dictation:
        this.dictation || this.speech
          ? {
              finalTimeoutMs: this.dictation?.finalTimeoutMs,
              stt: () => this.speech?.resolveDictationStt() ?? null,
              sttLanguage: this.speech?.resolveDictationSttLanguage() ?? "en",
              transcriptionPrompt:
                this.daemonConfigStore.get().dictationTranscriptionPrompt || undefined,
              getSpeechReadiness: () => this.speech!.getReadiness(),
            }
          : undefined,
```

- [ ] **Step 3: Build the server stack + typecheck**

Run: `npm run build:server`
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npm run format
git add packages/server/src/server/websocket-server.ts
git commit -m "feat(server): advertise + snapshot dictation transcription prompt per session"
```

---

## Task 9: Add i18n keys (`orchestration.dictationPrompt`) to all 6 locales

**Files:**

- Modify: `packages/app/src/i18n/resources/en.ts`, `es.ts`, `fr.ts`, `ru.ts`, `ar.ts`, `zh-CN.ts`
- Test: `packages/app/src/i18n/resources.test.ts` (parity + translation-threshold tests already exist; we satisfy them)

The keys go inside `settings.host.orchestration`, immediately after the existing `systemPrompt: { ... }` block (and before `orchestration`'s closing `},`). The card has no i18n `placeholder` key — its placeholder is the shared protocol constant (Task 10).

- [ ] **Step 1: en.ts** — insert after the `systemPrompt` block (closes ~line 1644):

```ts
        dictationPrompt: {
          title: "Dictation prompt",
          hint: "Guides how your speech is transcribed",
          sheetTitle: "Dictation transcription prompt",
          accessibilityLabel: "Dictation transcription prompt",
          edit: "Edit",
          reset: "Reset",
          save: "Save",
          saving: "Saving...",
        },
```

- [ ] **Step 2: es.ts** — insert after its `systemPrompt` block (~line 1676):

```ts
        dictationPrompt: {
          title: "Mensaje de dictado",
          hint: "Guía cómo se transcribe tu voz",
          sheetTitle: "Mensaje de transcripción de dictado",
          accessibilityLabel: "Mensaje de transcripción de dictado",
          edit: "Editar",
          reset: "Restablecer",
          save: "Guardar",
          saving: "Guardando...",
        },
```

- [ ] **Step 3: fr.ts** — insert after its `systemPrompt` block (~line 1681):

```ts
        dictationPrompt: {
          title: "Invite de dictée",
          hint: "Guide la transcription de votre voix",
          sheetTitle: "Invite de transcription de dictée",
          accessibilityLabel: "Invite de transcription de dictée",
          edit: "Modifier",
          reset: "Réinitialiser",
          save: "Sauvegarder",
          saving: "Sauvegarde...",
        },
```

- [ ] **Step 4: ru.ts** — insert after its `systemPrompt` block (~line 1668):

```ts
        dictationPrompt: {
          title: "Подсказка для диктовки",
          hint: "Определяет, как распознаётся ваша речь",
          sheetTitle: "Подсказка для транскрипции диктовки",
          accessibilityLabel: "Подсказка для транскрипции диктовки",
          edit: "Редактировать",
          reset: "Сбросить",
          save: "Сохранить",
          saving: "Сохранение...",
        },
```

- [ ] **Step 5: ar.ts** — insert after its `systemPrompt` block (~line 1638):

```ts
        dictationPrompt: {
          title: "موجه الإملاء",
          hint: "يوجّه كيفية تحويل كلامك إلى نص",
          sheetTitle: "موجه نسخ الإملاء",
          accessibilityLabel: "موجه نسخ الإملاء",
          edit: "تحرير",
          reset: "إعادة ضبط",
          save: "حفظ",
          saving: "جارٍ الحفظ...",
        },
```

- [ ] **Step 6: zh-CN.ts** — insert after its `systemPrompt` block (~line 1619):

```ts
        dictationPrompt: {
          title: "听写提示词",
          hint: "指导如何转写你的语音",
          sheetTitle: "听写转写提示词",
          accessibilityLabel: "听写转写提示词",
          edit: "编辑",
          reset: "重置",
          save: "保存",
          saving: "保存中...",
        },
```

- [ ] **Step 7: Run the i18n parity/threshold tests**

Run (from `packages/app`): `npx vitest run src/i18n/resources.test.ts --bail=1`
Expected: PASS — all 6 locales share identical keys; interpolation unaffected; translated values keep matching-English counts under threshold.

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck
npm run format
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/es.ts packages/app/src/i18n/resources/fr.ts packages/app/src/i18n/resources/ru.ts packages/app/src/i18n/resources/ar.ts packages/app/src/i18n/resources/zh-CN.ts
git commit -m "feat(app): add dictation prompt settings strings for all locales"
```

---

## Task 10: Add the `DictationPromptCard` and render it in the Agents section

**Files:**

- Modify: `packages/app/src/screens/settings/host-page.tsx` (imports top; new component after `AppendSystemPromptCard` ~line 883; render in `HostAgentsPage` lines 258-261)

`useSessionStore`, `useDaemonConfig`, `useHostRuntimeIsConnected`, `AdaptiveModalSheet`, `SheetHeader`, `SettingsTextAreaCard`, `Button`, `useState/useEffect/useMemo/useCallback`, `settingsStyles`, and `styles.appendPromptActions` are all already imported/defined in this file.

- [ ] **Step 1: Import the shared default constant**

Add near the other `@getpaseo/protocol` imports (after line 22):

```ts
import { DEFAULT_DICTATION_TRANSCRIPTION_PROMPT } from "@getpaseo/protocol/dictation-prompt";
```

- [ ] **Step 2: Add the `DictationPromptCard` component**

Insert immediately after the `AppendSystemPromptCard` function (after its closing brace ~line 883):

```tsx
function DictationPromptCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.dictationTranscriptionPrompt === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persistedPrompt = config?.dictationTranscriptionPrompt ?? "";
  const [draft, setDraft] = useState(persistedPrompt);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.orchestration.dictationPrompt.sheetTitle") }),
    [t],
  );

  useEffect(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  const hasChanges = draft !== persistedPrompt;

  const handleOpen = useCallback(() => {
    setDraft(persistedPrompt);
    setIsEditing(true);
  }, [persistedPrompt]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setDraft(persistedPrompt);
    setIsEditing(false);
  }, [isSaving, persistedPrompt]);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    void patchConfig({ dictationTranscriptionPrompt: draft })
      .then(() => {
        setIsEditing(false);
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to save dictation prompt", error);
      })
      .finally(() => setIsSaving(false));
  }, [draft, patchConfig]);

  const handleReset = useCallback(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  if (!isConnected || !isSupported) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-dictation-prompt-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.dictationPrompt.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.dictationPrompt.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleOpen}
            testID="host-page-dictation-prompt-edit"
          >
            {t("settings.host.orchestration.dictationPrompt.edit")}
          </Button>
        </View>
      </View>

      {isEditing ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="host-page-dictation-prompt-sheet"
          desktopMaxWidth={560}
        >
          <SettingsTextAreaCard
            testID="host-page-dictation-prompt-input"
            accessibilityLabel={t("settings.host.orchestration.dictationPrompt.accessibilityLabel")}
            value={draft}
            onChangeText={setDraft}
            placeholder={DEFAULT_DICTATION_TRANSCRIPTION_PROMPT}
          />
          <View style={styles.appendPromptActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleReset}
              disabled={!hasChanges || isSaving}
              testID="host-page-dictation-prompt-reset"
            >
              {t("settings.host.orchestration.dictationPrompt.reset")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || isSaving}
              testID="host-page-dictation-prompt-save"
            >
              {isSaving
                ? t("settings.host.orchestration.dictationPrompt.saving")
                : t("settings.host.orchestration.dictationPrompt.save")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}
```

- [ ] **Step 3: Render it in `HostAgentsPage`**

Modify the Agents `SettingsSection` (lines 258-261) to add the card after `AppendSystemPromptCard`:

```tsx
<SettingsSection title={t("settings.hostSections.agents")}>
  <InjectPaseoToolsCard serverId={serverId} />
  <AppendSystemPromptCard serverId={serverId} />
  <DictationPromptCard serverId={serverId} />
</SettingsSection>
```

- [ ] **Step 4: Typecheck + lint**

```bash
npm run typecheck
npm run lint -- packages/app/src/screens/settings/host-page.tsx
```

Expected: PASS.

- [ ] **Step 5: Manually verify in the app (golden path)**

Per CLAUDE.md, UI changes must be exercised in a browser. With the dev daemon + Expo web running (`npm run dev`, `npm run dev:app`):

- Go to Host → Agents. Confirm a **Dictation prompt** card appears under **Append to system prompt**.
- Tap **Edit** → the sheet's textarea placeholder shows the built-in default instruction.
- Type a custom prompt, **Save**. Reopen — the value persists. Confirm `.dev/paseo-home/config.json` has `features.dictation.transcriptionPrompt`.
- Clear the field, **Save** → reopen shows the default placeholder again.
  If you cannot run the UI, state so explicitly rather than claiming success.

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/app/src/screens/settings/host-page.tsx
git commit -m "feat(app): add dictation transcription prompt settings card"
```

---

## Task 11: Full-stack verification

- [ ] **Step 1: Rebuild everything that produces cross-package declarations**

```bash
npm run build:server
```

Expected: highlight + relay + protocol + client + server + cli build cleanly.

- [ ] **Step 2: Typecheck + lint the whole repo**

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: PASS.

- [ ] **Step 3: Re-run the changed test files (targeted, never the full suite)**

```bash
# from packages/protocol
npx vitest run src/messages.test.ts --bail=1
# from packages/server
npx vitest run src/server/persisted-config.test.ts src/server/daemon-config-store.test.ts src/server/dictation/dictation-stream-manager.test.ts --bail=1
# from packages/app
npx vitest run src/i18n/resources.test.ts --bail=1
```

Expected: all PASS.

- [ ] **Step 4: Back-compat sanity (manual reasoning, confirm in code)**

- New client + old daemon: `serverInfo.features.dictationTranscriptionPrompt` is absent → `DictationPromptCard` returns null (hidden). Confirm the `isSupported` gate covers this.
- Old client + new daemon: client omits `dictationTranscriptionPrompt`; daemon defaults to `""` → built-in default used. Confirm `MutableDaemonConfigSchema` default and the `|| undefined` normalization.

---

## Self-review (completed by plan author)

**Spec coverage:**

- Persisted `features.dictation.transcriptionPrompt` → Task 2. ✓
- Approach A flat mutable field + patch + capability flag → Task 3. ✓
- Shared default constant (Q3) → Task 1, consumed in Task 6 (server) + Task 10 (app placeholder). ✓
- config.ts resolve + bootstrap seed → Task 4. ✓
- daemon-config-store merge mapping → Task 5. ✓
- Resolution precedence env > setting > default → Task 6. ✓
- Session-snapshot from live store (Q1) → Task 8 (read `daemonConfigStore.get()` at session build) + Task 7 (thread-through). ✓
- Capability flag emission → Task 8; UI placement on Agents page (Q2) → Task 10; hide on old daemon (Q4) → Task 10 `isSupported` gate. ✓
- i18n across all locales → Task 9. ✓
- Tests (persisted-config, messages, daemon-config-store, dictation manager, i18n) → Tasks 2,3,5,6,9; full verification Task 11. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one descriptive note (Task 5 fixtures) points at concrete existing variables to match.

**Type consistency:** `dictationTranscriptionPrompt` (config/mutable/PaseoDaemonConfig/store), `transcriptionPrompt` (persisted `features.dictation`, `SessionOptions.dictation`, manager constructor param), `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT` (protocol export) — used consistently across Tasks 1–10.
