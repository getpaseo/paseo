# Design: Customizable dictation transcription prompt

**Date:** 2026-06-13
**Status:** Approved design — ready for implementation plan
**Scope:** Dictation only (not voice mode)

## Summary

The dictation speech-to-text "transcription prompt" — the instruction that biases how
spoken audio is transcribed — is currently hardcoded in
`packages/server/src/server/dictation/dictation-stream-manager.ts:174` and overridable
only via the `PASEO_DICTATION_TRANSCRIPTION_PROMPT` environment variable. This feature
makes it editable from the app's **Host → Agents** settings page, persisted to
`config.json` under `features.dictation.transcriptionPrompt`.

## Background — current state

- `handleStart` (dictation-stream-manager.ts:174) resolves the prompt as
  `process.env.PASEO_DICTATION_TRANSCRIPTION_PROMPT ?? "<built-in default>"` and passes it
  into the STT session (`createSession({ ..., prompt })`).
- The built-in default is:
  > "Transcribe only what the speaker says. Do not add words. Preserve punctuation and
  > casing. If the audio is silence or non-speech noise, return an empty transcript."
- `DictationStreamManager` is constructed once per client session at `session.ts:1328`
  with static params (`language`, `finalTimeoutMs`, …).
- Client-editable daemon settings flow through `MutableDaemonConfig` (protocol) ↔
  `DaemonConfigStore` (server) ↔ `get/set_daemon_config` RPCs ↔ `useDaemonConfig` (app).
  `MutableDaemonConfig` currently does **not** expose any `features.dictation` settings.
- `appendSystemPrompt` is the precedent: a free-text daemon-config string editable in
  settings end-to-end. We mirror its pattern.

## Settled decisions

From the design discussion and the web-ask decision doc (`/tmp/dictation-prompt-setting/`):

| #          | Decision                     | Choice                                                                                                                                                             |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope      | Which prompt(s)?             | **Dictation only.** Voice mode STT (voice-turn-controller.ts:320) stays prompt-less.                                                                               |
| Behavior   | Custom vs default            | **Replace.** Non-empty value replaces the built-in default; empty = built-in default.                                                                              |
| Wire shape | MutableDaemonConfig field    | **Approach A:** flat `dictationTranscriptionPrompt: string`, mirroring `appendSystemPrompt`.                                                                       |
| Q1         | When it takes effect         | **Snapshot at session start.** Read from the live `DaemonConfigStore` when the session initializes; edits apply on next reconnect. No live per-dictation resolver. |
| Q2         | UI placement                 | **Existing "Agents" settings page**, directly after `AppendSystemPromptCard`. No new nav.                                                                          |
| Q3         | Empty-editor placeholder     | **Show the built-in default text** as the placeholder. Default string moves to a shared `@getpaseo/protocol` constant to avoid client/server drift.                |
| Q4         | Older daemon (no capability) | **Hide the card entirely** when `serverInfo.features.dictationTranscriptionPrompt` is absent.                                                                      |

## Design

### Resolution precedence

At each dictation start (`handleStart`), the effective prompt resolves as:

```
PASEO_DICTATION_TRANSCRIPTION_PROMPT  (env)
  ?? configured setting               (from DaemonConfigStore, snapshotted at session init; empty string → treated as unset)
  ?? DEFAULT_DICTATION_TRANSCRIPTION_PROMPT  (shared constant)
```

This matches the codebase's existing env-over-persisted convention
(`firstSpeechDefinedValue` in `speech-config-resolver.ts`).

### Shared default constant

Move the built-in default string into the protocol package (e.g.
`packages/protocol/src/…` exporting `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT`). Import it
in:

- `dictation-stream-manager.ts` — the `?? DEFAULT` fallback (replacing the inline literal).
- the app's dictation prompt card — the textarea placeholder (Q3).

Single source of truth; no new runtime protocol message needed to surface the default.

### Persisted data model — `packages/server/src/server/persisted-config.ts`

Add to `FeatureDictationSchema` (currently lines 89–102):

```ts
transcriptionPrompt: z.string().optional(),
```

Stored at `features.dictation.transcriptionPrompt`.

### Protocol — `packages/protocol/src/messages.ts` (Approach A)

- `MutableDaemonConfigSchema` (line 131): add `dictationTranscriptionPrompt: z.string().default("")`.
- `MutableDaemonConfigPatchSchema` (line 146): add `dictationTranscriptionPrompt: z.string().optional()`.
- `ServerInfoStatusPayloadSchema.features` (line ~2163): add
  `dictationTranscriptionPrompt: z.boolean().optional()` with
  `// COMPAT(dictationTranscriptionPrompt): added in v0.1.X, remove after 2026-12-13`.

### Server wiring

1. **`config.ts`** — resolve `features.dictation.transcriptionPrompt` onto
   `PaseoDaemonConfig` (mirror `resolveAppendSystemPrompt`, config.ts:316/329). Used to seed
   the config store initial.
2. **`bootstrap.ts:301`** — seed `dictationTranscriptionPrompt` into the
   `DaemonConfigStore` initial object (alongside `appendSystemPrompt`, line 318).
3. **`daemon-config-store.ts` (`mergeMutableConfigIntoPersistedConfig`, line 170)** — map
   `mutable.dictationTranscriptionPrompt` → `persisted.features.dictation.transcriptionPrompt`
   so saves round-trip. (Note: `appendSystemPrompt` maps to `persisted.daemon.*`; this one
   maps to `persisted.features.dictation.*`.)
4. **`websocket-server.ts`**
   - Features block (line ~1092): add `dictationTranscriptionPrompt: true`.
   - Dictation session options (line ~953): include the configured prompt, read from the
     current `DaemonConfigStore` value at session-init time (empty string normalized to
     undefined).
5. **`session.ts:1328`** — pass the configured prompt into the `DictationStreamManager`
   constructor as a new optional param.
6. **`dictation-stream-manager.ts`**
   - Constructor: accept `transcriptionPrompt?: string`.
   - `handleStart` (line 174): resolve `env ?? this.transcriptionPrompt ?? DEFAULT` using the
     shared constant.

### App UI — `packages/app/src/screens/settings/host-page.tsx`

- Add a `DictationPromptCard` component (clone of `AppendSystemPromptCard`, lines 770–883):
  `AdaptiveModalSheet` + `SettingsTextAreaCard` + reset/save buttons; writes
  `patchConfig({ dictationTranscriptionPrompt })` via `useDaemonConfig`.
- Placeholder = `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT` (Q3).
- Render it inside `HostAgentsPage`'s "AGENTS" section (lines 258–261), after
  `AppendSystemPromptCard`.
- **Gate (Q4):** render only when `serverInfo.features.dictationTranscriptionPrompt` is
  present (read via the session-context selector pattern used for `checkoutRefresh`,
  `githubCheckDetails`, etc.).
- i18n: add strings under a `settings.host.…dictationPrompt.*` group (title, hint, sheet
  title, edit/save/saving/reset, accessibility label). `en` is authoritative; mirror the
  locale coverage that `settings.host.orchestration.systemPrompt.*` already has.

## Backward compatibility

Per the protocol contract (CLAUDE.md):

- **Old client → new daemon:** old client omits `dictationTranscriptionPrompt`; daemon
  defaults it to `""` (= built-in default). No break.
- **New daemon → old client:** old client ignores the unknown mutable-config field and the
  unknown `features.dictationTranscriptionPrompt` flag (`.passthrough()` / `.optional()`).
- **New client → old daemon:** the capability flag is absent, so the new client **hides**
  the card (Q4). The user never writes a value the old daemon would silently ignore. This
  is the feature contract — no fallback path.

The shared default constant and the new schema fields are additive and optional.

## Testing

- **Server unit**
  - `persisted-config.test.ts`: round-trip parse/save of `features.dictation.transcriptionPrompt`.
  - `daemon-config-store.test.ts`: patching `dictationTranscriptionPrompt` maps to
    `persisted.features.dictation.transcriptionPrompt` and persists.
  - `dictation-stream-manager.test.ts`: resolution precedence — env > configured > default;
    empty configured string → default; configured non-empty → used.
- **App**
  - Card renders only when the capability flag is present; hidden otherwise.
  - Save calls `patchConfig({ dictationTranscriptionPrompt: <value> })`.
  - Placeholder shows the shared default constant.
  - (Mirror `providers-section.test.tsx` patterns.)

Run only the specific changed test files (never the full suite locally), per CLAUDE.md.

## Out of scope

- Voice mode STT prompt (`voice-turn-controller.ts:320`) — explicitly deferred.
- Other dictation settings (provider / model / language / confidence) — stay env/file-only.
- Live per-dictation re-resolution — rejected in favor of session-snapshot (Q1).

## Files touched (implementation checklist)

- `packages/protocol/src/messages.ts` — mutable config fields + capability flag.
- `packages/protocol/src/…` — new `DEFAULT_DICTATION_TRANSCRIPTION_PROMPT` export.
- `packages/server/src/server/persisted-config.ts` — `FeatureDictationSchema`.
- `packages/server/src/server/config.ts` — resolve onto `PaseoDaemonConfig`.
- `packages/server/src/server/bootstrap.ts` — seed config-store initial.
- `packages/server/src/server/daemon-config-store.ts` — merge mapping.
- `packages/server/src/server/websocket-server.ts` — features flag + dictation session options.
- `packages/server/src/server/session.ts` — pass prompt to manager.
- `packages/server/src/server/dictation/dictation-stream-manager.ts` — constructor + handleStart + shared default.
- `packages/app/src/screens/settings/host-page.tsx` — `DictationPromptCard` + gating.
- `packages/app/src/i18n/resources/*.ts` — strings.
- Tests as listed above.
