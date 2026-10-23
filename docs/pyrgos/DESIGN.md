# Pyrgos Paseo: design note (MIC-750 A)

Voice conversation agent inside this fork of getpaseo/paseo. B, C and D start from this file.
Paths are relative to the repo root. "Core change" means an edit outside `packages/server/src/server/pyrgos/`
and `docs/pyrgos/`. Config comes from env vars; names only, never values.

## 1. Decision summary

| Piece | Where it lives | How it plugs in |
|---|---|---|
| B conversation agent | `packages/server/src/server/pyrgos/conversation-agent/` | One optional "voice brain" hook on `VoiceSession` (core change 2). Falls back to stock voice mode when unset. |
| C ledger + feed | `packages/server/src/server/pyrgos/ledger/` (pure), `packages/server/src/server/pyrgos/feed/` (I/O), UI in `plugins/pyrgos-ledger/` | Ledger is a pure module; B owns the instance; the UI is a normal plugin (`docs/plugins.md:565` file panels, `:530` sidebar items). |
| D lab speech | `packages/server/src/server/pyrgos/speech/` | New provider id `lab` in the closed enum (core change 1). |

Rule: B imports C and D only through the interfaces in section 4. C and D never import B.

## 2. Existing seams (verified in this checkout)

Voice turn today (stock):

1. Client streams PCM as `voice_audio_chunk`; `VoiceSession` (`packages/server/src/server/session/voice/voice-session.ts`)
   buffers, runs turn detection, calls the STT provider.
2. `handleTranscriptionResultPayload` (`voice-session.ts:964`) emits `transcription_result` and `activity_log`, then calls
   `host.sendSpokenInput(agentId, text)` (`voice-session.ts:~1049`). The host (`packages/server/src/server/session.ts:1250`) forwards to
   `handleSendAgentMessage(..., { spokenInput: true })`.
3. The bound Paseo agent answers by calling the `speak` MCP tool. `registerVoiceBridgeForAgent` (`voice-session.ts:~1061`)
   installs a `VoiceSpeakHandler` (`session/voice/voice-types.ts`) that calls `ttsManager.generateAndWaitForPlayback(text, emit, signal, true)`
   (`packages/server/src/server/agent/tts-manager.ts:150`), then emits `activity_log`.
4. Voice mode is enabled per socket by `set_voice_mode {enabled, agentId}` (`voice-session.ts:354`), which stores `voiceModeAgentId`
   and rewrites the agent prompt (`session/voice/voice-config.ts`, `buildVoiceModeSystemPrompt`).
5. `abort_request` -> `handleAbort` (`voice-session.ts:~1097`); `audio_played` -> `handleAudioPlayed` (`voice-session.ts:~1142`).

Wire events (names fixed by `packages/protocol/src/messages.ts`; listed in `docs/architecture.md:298`):
inbound `voice_audio_chunk`, `abort_request`, `audio_played`, `set_voice_mode`, `dictation_stream_*`;
outbound `audio_output`, `transcription_result`, `voice_input_state`, `set_voice_mode_response`, `activity_log`, `assistant_chunk`.
We add no wire events in v1 (see section 6).

Speech provider interfaces (`packages/server/src/server/speech/speech-provider.ts`):

```ts
interface SpeechToTextProvider { id: string; createSession(p: { logger; language?; prompt? }): StreamingTranscriptionSession } // PCM16LE in; committed/transcript/error out
interface TextToSpeechProvider { synthesizeSpeech(text: string): Promise<{ stream: Readable; format: string }> }
```

Resolution: `speech/speech-runtime.ts:50-60` defaults all four roles (`dictationStt`, `voiceTurnDetection`, `voiceStt`, `voiceTts`) to `local`;
`speech/speech-types.ts` declares `SpeechProviderIdSchema = z.enum(["openai", "local"])` (closed).

Plugin APIs (`packages/plugin/src/server/contracts.ts:30`): `PluginServerContext` offers `handle(contract, handler)` (RPC with
`context.paseo: PaseoApi`), `registerSettings`, `registerProvider` (agent providers, not speech), `registerUsageSource`, plus lifecycle
`server.on(...)` / `server.before(...)` (`packages/plugin/src/server/lifecycle.ts:48-75`: `agent.created`, `agent.turn_ended`,
`agent.closed`, `workspace.created`, before-hooks `agent.create`, `workspace.create`). Plugins cannot register speech providers or
voice hooks: that is why core changes 1 and 2 exist.

Agent launch: `PaseoApi.agents.create(options): Promise<PaseoAgentHandle>` (`packages/client/src/index.ts:391-406`), also the
`create_agent` tool (`packages/server/src/server/agent/tools/paseo-tools.ts:1586`) and `createAgentCommand`
(`packages/server/src/server/agent/create-agent/create.ts:156`).

## 3. Core changes (the whole list; each is small)

| # | File | Change | Why unavoidable |
|---|---|---|---|
| 1 | `packages/server/src/server/speech/speech-types.ts` | Add `"lab"` to `SpeechProviderIdSchema`. | The enum is closed; config parsing rejects unknown ids. |
| 1b | `packages/server/src/server/speech/speech-runtime.ts` | In the provider build step, when a role resolves to `lab`, call `createLabSpeech(config)` from `pyrgos/speech`. Default for `voiceTts` and `voiceStt` becomes `lab` only when `PYRGOS_LAB_TTS_URL` / `PYRGOS_LAB_STT_URL` is set; else stays `local` (stock fallback). | Providers are constructed in this one function; no registry exists. |
| 2 | `packages/server/src/server/session/voice/voice-session.ts` (+ `index.ts` options type) | Add optional `VoiceBrain` to `VoiceSessionOptions`. In `handleTranscriptionResultPayload`, if a brain is set, call `brain.onUtterance(text, ctx)` instead of requiring a bound agent and `host.sendSpokenInput`. Abort calls `brain.cancel()`. Wire `speak` through the existing `ttsManager` path so playback acks, abort and `activity_log` behave identically. | The seam today only forwards text to a Paseo agent whose reply costs a full agent turn and an MCP `speak` call; sub-2 s replies need a direct call. |
| 3 | `packages/server/src/server/session.ts` (near `:1250`) | Construct the brain from `pyrgos/conversation-agent` when `PYRGOS_VOICE=1` and pass it in the options. | Session assembly is the only place that knows the host callbacks. |
| 4 | `packages/server/src/server/bootstrap.ts` (or the file that builds `PluginServerContext`; B/C confirm the exact name) | Expose the ledger and feed to the ledger plugin through a handler context field, or run the plugin RPC against a module singleton. | Plugin handlers only receive `paseo`; they need ledger reads. Preferred: the ledger plugin's `index.server.ts` imports `pyrgos/ledger` through the plugin-local copy (no core change) and reads the same JSONL file. Only add this change if that proves racy. |

Everything else is additive under `pyrgos/`, `plugins/pyrgos-ledger/` and `docs/pyrgos/`. Upstream merge surface: three small edits
plus one optional.

`VoiceBrain` (defined in `pyrgos/conversation-agent/types.ts`, imported by `voice-session.ts` as a type only):

```ts
export interface VoiceBrainContext {
  speak(sentence: string, signal: AbortSignal): Promise<void>; // = ttsManager.generateAndWaitForPlayback(...), emits activity_log
  signal: AbortSignal;                                         // aborted by abort_request or a new user utterance
}
export interface VoiceBrain {
  onUtterance(text: string, ctx: VoiceBrainContext): Promise<void>; // resolves when the turn is spoken
  cancel(): void;
  dispose(): void;
}
```

## 4. Interfaces between B, C and D

### 4.1 C: ledger (pure, no I/O except the JSONL path passed in)

`packages/server/src/server/pyrgos/ledger/index.ts`:

```ts
export type ItemState = "draft" | "refined" | "agreed" | "dropped";
export interface ActionItem {
  id: string;            // ulid; stable
  text: string;          // one line, <= 400 chars
  state: ItemState;
  createdAt: string;     // ISO; injected clock
  updatedAt: string;
  transcriptRef: string; // "<session-file>#<line>" from the feed
  launched?: { agentId: string; lane: string } | null;
}
export interface Ledger {
  list(filter?: { state?: ItemState }): ActionItem[];
  propose(text: string, transcriptRef: string): ActionItem;                 // -> draft
  refine(id: string, text: string): ActionItem;                             // draft|refined -> refined
  agree(id: string, evidence: { transcriptRef: string; phrase: string }): ActionItem; // refined -> agreed
  drop(id: string): ActionItem;                                             // any non-agreed -> dropped
  markLaunched(id: string, launch: { agentId: string; lane: string }): ActionItem;
  subscribe(fn: (items: ActionItem[]) => void): () => void;
}
export function createLedger(opts: { path: string; clock?: () => Date; id?: () => string }): Ledger;
```

Rules: transitions are exactly draft->refined->agreed, with drop from draft/refined; anything else throws `LedgerTransitionError`.
`agree` throws unless `evidence.phrase` normalizes to one of the agreement phrases ("yes, do it", "yes do it"); the caller (B) passes
the user's actual transcript line, so agreement cannot come from the model alone. Persistence: append-only JSONL, one event per line
(`{ts, op, id, ...}`), replayed on `createLedger`. Changes since the contract in the MIC-750 brief: `agree` takes `evidence`, and
`markLaunched` plus `subscribe` are added. These are additive.

### 4.2 B: conversation agent

`packages/server/src/server/pyrgos/conversation-agent/index.ts`:

```ts
export function createConversationAgent(deps: {
  ledger: Ledger;
  feed: Feed;                 // 4.3
  launcher: AgentLauncher;    // 4.4
  llm: ChatBrain;             // Claude via subscription, see below
  logger: Logger;
}): VoiceBrain;
```

- `ChatBrain.stream(messages, tools, signal): AsyncIterable<{ type: "text"; delta: string } | { type: "tool_call"; name; args }>`.
  Implementation uses the Claude Agent SDK / Claude Code login that Paseo's Claude provider already uses
  (`packages/server/src/server/agent/providers/claude/`; B reads the Claude adapter there and reuses its auth path). No API key, no metered call.
- Sentence chunker (port of `voice_agent/chunker.py` in the voice-agent repo): flush each completed sentence to `ctx.speak` while the
  stream continues. First audio target: under 2 s from end of user speech.
- Context (port of `voice_agent/context.py`): harness summary text built once at start and refreshed on a timer, redacted of secrets.
  Source path from env `PYRGOS_CONTEXT_FILE`; absent means no context.
- Tools exposed to the model (names fixed so prompts and tests agree): `propose_item(text)`, `refine_item(id, text)`,
  `drop_item(id)`, `list_items()`, `request_agreement(id)`. There is **no** `agree` or `launch` tool: B itself calls `ledger.agree` only when
  the last user utterance matches the agreement phrase and an item is in `refined` and was read back in the previous assistant turn.
  After `agree`, B calls `feed.announce` then `launcher.launch`; the model is told afterwards.
- Hard rules in the system prompt and in code: never push, merge, delete or spend; only record, announce and launch through the lanes.

### 4.3 C: overseer feed (`packages/server/src/server/pyrgos/feed/`)

```ts
export interface Feed {
  append(speaker: "user" | "assistant" | "overseer" | "system" | "action", text: string): { line: number; ref: string };
  announce(item: ActionItem): { ok: boolean; via: "surface" | "inbox"; line: string };
  watchReplies(onReply: (reply: { ts: string; text: string }) => void): () => void;
}
export function createFeed(opts: { dir: string; sessionId: string; clock?; exec?; home? }): Feed;
```

Direct ports of `voice_agent/feed.py` (pyrgos-voice-agent repo), same formats so the overseer's existing tooling keeps working:

- Transcript: `<dir>/<sessionId>.jsonl`, one `{ts, speaker, text}` per line, appended under a file lock so `line` is the 1-based number of
  the line just written. B appends every user utterance and assistant sentence.
- Announce line, one line, max 400 chars, truncated with an ellipsis:
  `[voice] ACTION: <item> (transcript: <path>#<line>)`.
  Delivery: if env `PYRGOS_OVERSEER_SURFACE` is set, run the configured send command for that surface; otherwise append the line to the
  lab-side inbox file (`pc-inbox.md` in the home directory, name overridable by `PYRGOS_INBOX_FILE`). Env names only; values stay local.
- Replies: the overseer appends `{ts, text}` lines to `<dir>/<sessionId>.replies.jsonl`. `watchReplies` tails it (poll about 1 s,
  each line delivered once).
- Dir: env `PYRGOS_FEED_DIR`; default a `pyrgos-feed` folder under the OS state dir.

### 4.4 Agent launcher (B uses, C owns the wiring to dispatch)

```ts
export interface AgentLauncher {
  launch(item: ActionItem): Promise<{ agentId: string; lane: string }>;
}
```

Launch path for an `agreed` item (never before):

1. `PaseoApi.agents.create({ ... })` (`packages/client/src/index.ts:400`) with `initialPrompt` = the item text + transcript ref, in a
   workspace chosen by `PYRGOS_LAUNCH_WORKSPACE` (or the project the user named). Default provider = the daemon's configured default.
   Server-side code gets a `PaseoApi` the same way plugin handlers do (`PluginHandlerContext.paseo`, `packages/plugin/src/server/contracts.ts:11`);
   B/C pick whichever construction the module can reach without a core change (loopback `createPaseoClient` is acceptable).
2. Lane choice: for items the user marks as a ticket, the launcher shells out to the harness dispatcher with a fixed argv
   (`dispatch.sh <kind> "<spec>" --ticket <id>` or the `.ps1` twin on Windows), located via env `PYRGOS_DISPATCH_CMD`. This is a
   configured command, never model-built shell text. When unset, step 1 only.
3. On success: `ledger.markLaunched`, `feed.append("system", ...)`, and the assistant says so aloud.

Guardrail: `launch` refuses any item whose state is not `agreed` or whose agreement evidence is missing.

### 4.5 D: lab speech providers

`packages/server/src/server/pyrgos/speech/index.ts`:

```ts
export function createLabSpeech(cfg: LabSpeechConfig): { tts: TextToSpeechProvider; stt: SpeechToTextProvider };
export interface LabSpeechConfig { ttsUrl: string; sttUrl: string; voice: string }
```

- Config env: `PYRGOS_LAB_TTS_URL`, `PYRGOS_LAB_STT_URL` (websocket URLs), `PYRGOS_LAB_VOICE`
  (default `profile:winner-r6-s49-heart-alice-bella`, the locked preset; mirrors `LOCAL_REPLY_VOICE` in
  `voice_agent/services.py` of the voice-agent repo).
- TTS: websocket client for the lab server (`lab/tts_server.py`, Kokoro). Client sends `{"type":"speak","text","voice"}`; server streams
  audio frames. Provider returns `{ stream, format }` matching what `tts-manager.ts` expects (check the format string used by the stock
  local provider and match it; resample inside D if the lab emits a different rate).
- STT: websocket client for the lab server (`lab/stt_server.py`, faster-whisper small.en). Implements `StreamingTranscriptionSession`
  (PCM16LE in; committed/transcript/error out) per `speech-provider.ts`.
- Fallback: if the websocket does not connect within a short timeout, or drops mid-turn, the provider throws a typed
  `LabUnavailableError` and `speech-runtime.ts` (core change 1b) falls back to the stock `local` provider for that turn. A health probe
  at startup logs which one is active.
- Tests: fake websocket servers in-process; no network, no GPU.

## 5. Turn flow, including a spoken overseer reply

```mermaid
sequenceDiagram
  participant U as User (mic)
  participant VS as VoiceSession
  participant STT as D lab STT
  participant B as B conversation agent
  participant L as C ledger
  participant F as C feed
  participant TTS as D lab TTS
  participant O as Overseer
  U->>VS: voice_audio_chunk
  VS->>STT: PCM16 stream
  STT-->>VS: transcript
  VS->>B: brain.onUtterance(text)
  B->>F: append(user)
  B->>L: propose / refine (tool calls)
  B-->>VS: speak(sentence) per sentence
  VS->>TTS: synthesizeSpeech
  TTS-->>U: audio_output
  U->>VS: "yes, do it"
  VS->>B: onUtterance
  B->>L: agree(evidence)
  B->>F: announce -> "[voice] ACTION: ..."
  F->>O: surface or inbox line
  B->>B: launcher.launch -> agents.create
  O-->>F: replies.jsonl line
  F-->>B: watchReplies callback
  B-->>VS: speak at next turn boundary
```

Turn-boundary reply (port of `TurnGate`/`pump_replies`, `voice_agent/feed.py`): B keeps a gate with flags `user` (from
`voice_input_state`/speech start), `bot` (TTS playing, cleared on `audio_played`) and `llm` (a stream is open). A queued overseer reply is
spoken only when all three are false. B spoke it as `The overseer says: <text>` through the same `ctx.speak`, appends an `overseer` line to
the transcript after queuing, and re-checks the gate before each further reply because the user may start talking. If the user starts
talking, pending replies wait; a reply is never spoken over the user. `ctx.speak` outside an utterance needs a standing context: B holds
the last `VoiceBrainContext` for the socket and refreshes it on each utterance; with no active socket, replies stay queued.

## 6. Client / UI

- Voice client code is untouched: `packages/app/src/voice/voice-runtime.ts` already handles streaming, `audio_output` and aborts on
  desktop (Electron `packages/desktop`) and Expo Android, so C/B work on all three targets without client edits.
- Ledger panel: plugin `plugins/pyrgos-ledger/` (`index.client.tsx`, `index.server.ts`, `shared/` zod contracts, `paseo-plugin.json`
  as in `plugin-examples/markdown-panel/`). RPC contracts: `ledger.list`, `ledger.subscribe`-style polling via `handle()` (no new wire
  events), `ledger.drop(id)`. The panel never calls `agree`; agreement is voice-only. Buttons: use `docs/plugins.md:585` pattern.
- Lab reaches the Android app through the existing relay/Tailscale path; D adds no inbound ports.

## 7. Tests and layout

- B, C, D are each unit-tested with the repo's runner (`docs/development.md`; B/C/D confirm the command), tests first, with injected
  clock, fake LLM stream, fake websockets and a temp dir for JSONL.
- Contract tests live in `packages/server/src/server/pyrgos/__tests__/contracts.test.ts` (A adds none; B owns this file and the type
  imports in section 4 are copied verbatim into `pyrgos/types.ts` by whichever of B/C lands first).
- Docs: each piece appends to `docs/pyrgos/HOW-IT-WAS-BUILT.md` and `docs/pyrgos/skill-log.md`.

## 8. Open questions (assumed until settled)

1. Core change 4 (ledger visibility to the plugin): assumed unnecessary because both sides read the same JSONL. Settle by C building
   the panel first.
2. Direct brain vs bound Paseo agent: assumed direct (core change 2) because the stock path adds an agent turn and an MCP call to every
   reply. Settle by B measuring time-to-first-audio on both; if the stock path is under 2 s, drop core change 2.
3. Exact audio format of `TextToSpeechProvider.synthesizeSpeech` results: D reads the stock local provider and matches it.
4. Which Claude path in `agent/providers/` gives streaming text without a full agent loop: B decides after reading the adapter.
