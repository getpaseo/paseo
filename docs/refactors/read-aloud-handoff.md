# Read Aloud — Session Handoff

Picking this up cold? Read this, then
[read-aloud-footer-button-plan.md](./read-aloud-footer-button-plan.md), which records why
the feature moved off text selection.

- **Branch:** `text-selection-speech-modal`, branched from `d1ce2b77f`. The branch name
  predates the pivot; the feature is no longer selection-based.

## What the feature is

Every completed agent turn has a speaker button in its footer, next to copy. Press it and
the daemon speaks the turn's **closing message** — the prose after the last tool call, not
the narration in between. Press again to stop. Starting a read on another turn supersedes
the first: playback is one app-wide slot.

It started as a floating button anchored to a live text selection. The project owner asked
for the footer instead ("just speaking the message after the last tool call should be
enough"), which deleted ~1,138 lines of anchoring, placement, and bubble code and resolved
two Greptile P1s about selected text crossing daemon boundaries.

**Web and Electron only, for now** — but for a different reason than before. Selection was
web-only because RN exposes no selection API; the footer button has no such limit. What
blocks native now is only that `read-aloud-audio.ts` is a playback stub
(`isReadAloudAudioSupported = false`). Implementing it with expo-audio makes the button
work on iOS/Android with no other change. That is the obvious next task.

Uses the **existing voice-mode TTS provider** (local Kokoro by default, or OpenAI). No
ElevenLabs — the existing provider already has config, env vars, and docs plumbing.

### Architecture

| Piece                                           | What it does                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `protocol/src/messages.ts`                      | `speech.tts.read_aloud.request` → N `.response` segments; `…cancel_read_aloud.request` |
| `server/session/voice/read-aloud-controller.ts` | Sanitize → split → synthesize with 2-segment prefetch → stream                         |
| `server/speech/read-aloud-text.ts`              | Strips markdown and Paseo wrapper tags before synthesis                                |
| `server/speech/tts-text-splitter.ts`            | Extracted from `tts-manager.ts`; **shared with voice mode**                            |
| `client/src/daemon-client.ts`                   | `startReadAloud()` returns a handle with `cancel()`                                    |
| `app/src/agent-stream/strategy.ts`              | `collectAssistantTurnSpeech` — walks back, stops at the last `tool_call`               |
| `app/src/read-aloud/turn-read-aloud-button.tsx` | The footer button; owns gating and stop intent                                         |
| `app/src/read-aloud/read-aloud-store.ts`        | Playback state machine, `ownerId`, generation counter, speed                           |
| `app/src/read-aloud/use-read-aloud-host.ts`     | Route-host binding — speech never crosses to another paired daemon                     |
| `app/src/read-aloud/read-aloud-audio.web.ts`    | Reuses the voice-mode `AudioEngine` (playback context only, no mic)                    |

Segmented streaming is not gold-plating: local TTS returns raw 24 kHz PCM (~48 KB/s), so a
long message in one frame would be megabytes.

**Capability-gated** on `server_info.features.readAloud` (`COMPAT(readAloud)`, v0.2.5).
Hosts without it get no button. No fallback path.

## Environment gotchas — every one of these cost real time to rediscover

**1. Node 22+ is required for the dev daemon.** In dev the daemon runs from TS source and
forks the local speech worker with `--experimental-strip-types`, a Node 22+ flag, using
`process.execPath`. On Node 20 the worker dies instantly (`exit code 9`) and every
synthesis fails. nvm default here is v20.19.6; v22.20.0 and v23.3.0 are installed.

```bash
nvm use 22
```

This is pre-existing and not read-aloud specific — voice mode and dictation break the same
way.

**2. The daemon does NOT hot-reload.** `packages/server/scripts/dev-runner.ts` has no
watcher. The Expo app hot-reloads; the daemon does not. **Restart `npm run dev` after any
server change** or you will test stale code and draw wrong conclusions.

**2b. `nvm use 22` does not work from a non-interactive shell here.** The zsh profile
installs an nvm lazy-load shim, and outside an interactive shell the shim recurses until zsh
gives up with `maximum nested function level reached` — `node`, `npm`, and `npx` all fail,
and prepending to `PATH` does not help because the shell _function_ shadows the binary. Call
the binary by absolute path instead:

```bash
~/.nvm/versions/node/v22.20.0/bin/node ~/.nvm/versions/node/v22.20.0/bin/npm run typecheck
```

**3. `Buffer` is not a browser global.** Every consumer imports it explicitly
(`voice/voice-runtime.ts:1`). `@types/node` makes a bare `Buffer` reference typecheck while
failing at runtime in the bundle. This already caused one silent no-audio bug.

## Running it

```bash
nvm use 22
npm run dev        # terminal 1 — daemon on 127.0.0.1:6768
npm run dev:app    # terminal 2 — Expo web on http://localhost:8081
```

No extra env needed: `dev-app.sh` derives the daemon endpoint from `PASEO_LISTEN`, and
`dev-daemon.sh` defaults `PASEO_LOCAL_MODELS_DIR` to `~/.paseo/models/local-speech`, which
already has Kokoro — so no ~1 GB model download.

Runs alongside the user's normal Paseo on **6767** — different port, different `PASEO_HOME`
(`.dev/paseo-home`). **Never restart the 6767 daemon**; it manages live agents. The dev
home already has a project and workspace registered from earlier testing.

To try it: open a workspace with an agent that has finished at least one turn, and press
the speaker button in that turn's footer, next to the copy button.

### Probing the daemon directly

Faster than the UI for server-side questions. Connect to `ws://localhost:6768/ws`, send a
`hello` frame **first** (session messages before hello are rejected), then wrap requests as
`{type: "session", message: {…}}`. Run the script from the repo root so `ws` resolves.

## Open questions for the next session

- **Segment gaps.** Local Kokoro runs ~1× realtime with a ~6 s cold start. The splitter
  emits one segment per sentence, so a short first sentence ("Are you working?" → 1.79 s)
  drains before the next finishes synthesizing — measured **6.1 s of silence** mid-read.
  Three options, none implemented, user has not chosen:
  1. Pack short sentences into ~250-char chunks, **read-aloud only** — do not touch the
     shared splitter, voice mode wants the fast short first segment. Recommended.
  2. Buffer two segments before starting. Gapless, but start moves ~6 s → ~13 s. Worse.
  3. Switch to OpenAI TTS — far faster than realtime, gaps vanish, needs an API key.
- **Error detail is dropped.** Unknown failure codes render the generic "Couldn't read that
  aloud"; the daemon's real message sits unused in `failure.message`. Worth surfacing on
  hover so the next failure is self-diagnosing.
- **Markup sanitization is unit-tested only.** It has not been exercised against a live
  daemon. Confirm a turn containing a `<spoken-input>` block or a fenced code block speaks
  only the prose.
- **Native audio is unimplemented.** `read-aloud-audio.ts` is a stub, so the button hides
  on iOS/Android. Nothing else blocks native now that selection is gone.

## Things I got wrong — don't repeat them

- **Claimed "verified end-to-end" when I had only verified the state machine.** The UI went
  idle → Stop → idle exactly as it would on success, but that transition was driven by a
  swallowed error, and no audio sample ever reached the output. Two bugs hid in that gap.
  For anything audio- or layout-related, assert on the real artifact — buffer peaks,
  `getBoundingClientRect()` — not on labels.
- **Forced `/opt/homebrew/bin/node` (v24) onto PATH** so my runs worked, which masked the
  Node 20 worker crash the user hit immediately. Verify in the environment the user
  actually runs, not one bent to work.
- **Swallowed errors in a `.catch(() => {})`.** Turned a hard `ReferenceError` into "no
  error, no sound", the worst possible failure mode. That catch now reports.
- **Built the hard version first.** Selection anchoring — endpoint rects, clipping
  ancestors, placement clamping — was ~1,138 lines that the owner replaced with a button in
  a footer. The expensive part was never the speech; it was the anchoring nobody asked for.
