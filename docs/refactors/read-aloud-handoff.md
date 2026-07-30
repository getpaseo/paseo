# Read Aloud — Session Handoff

Picking this up cold? Read this, then
[read-aloud-selection-anchoring-plan.md](./read-aloud-selection-anchoring-plan.md) — all
three of its steps have since landed, and its Outcome section records what shipped.

- **Branch:** `text-selection-speech-modal`, branched from `d1ce2b77f`.

## What the feature is

Select text on web/desktop → a 32×32 speaker button floats above the selection → press it
and the daemon speaks the selection back. Press again, or clear the selection, to stop.

**Web and Electron only.** React Native exposes no JS API for the current text selection —
iOS hands it to the system edit menu, Android to an ActionMode — so there is nothing to
anchor to on the mobile apps. `read-aloud-selection-bubble.tsx` (the non-`.web` file) is a
deliberate `return null`. Closing that gap would mean a turn-level "Read aloud" button next
to the copy button, reading the whole turn instead of a selection. Not built; not started.

Uses the **existing voice-mode TTS provider** (local Kokoro by default, or OpenAI). No
ElevenLabs — the existing provider already has config, env vars, and docs plumbing.

## State: what works, verified how

Green as of handoff: `npm run typecheck`, `npm run lint`, `npm run format`, 42 server tests
(`packages/server/src/server/speech/read-aloud-text.test.ts`,
`src/server/session/voice/`, `src/server/agent/tts-manager.test.ts`), 50 app tests
(`src/i18n/resources.test.ts`, `src/voice/voice-runtime.test.ts`).

Verified in a real browser via Playwright against the dev stack: button appears above the
selection; press → stop square + selection survives the press; press again → idle; click
away → button gone and playback stopped. Audio confirmed reaching the output graph by
instrumenting `AudioContext` — two segments, non-silent buffers (peak 0.27 / 0.35), context
`running`.

Since then, anchoring was rewritten. Also green: 14 new tests
(`packages/app/src/read-aloud/read-aloud-placement.test.ts`) and nine browser cases measured
off real `getBoundingClientRect()` values — see the plan's Outcome section for the table.

### Architecture

| Piece                                                    | What it does                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `protocol/src/messages.ts`                               | `speech.tts.read_aloud.request` → N `.response` segments; `…cancel_read_aloud.request` |
| `server/session/voice/read-aloud-controller.ts`          | Sanitize → split → synthesize with 2-segment prefetch → stream                         |
| `server/speech/read-aloud-text.ts`                       | Strips markup before synthesis                                                         |
| `server/speech/tts-text-splitter.ts`                     | Extracted from `tts-manager.ts`; **shared with voice mode**                            |
| `client/src/daemon-client.ts` → `startReadAloud()`       | Returns a handle with `cancel()`; streams via `on(…response)`                          |
| `app/src/read-aloud/use-selection-anchor.web.ts`         | Endpoint rects + the clipping-ancestor `visibleBox`; retains during playback           |
| `app/src/read-aloud/read-aloud-placement.ts`             | Pure above/below/park decision and clamping; unit-tested                               |
| `app/src/read-aloud/read-aloud-selection-bubble.web.tsx` | Renders into `#overlay-root`; owns the widths and stop intent                          |
| `app/src/read-aloud/read-aloud-store.ts`                 | Playback state machine, generation counter, speed                                      |
| `app/src/read-aloud/read-aloud-audio.web.ts`             | Reuses the voice-mode `AudioEngine` (playback context only, no mic)                    |

Segmented streaming is not gold-plating: local TTS returns raw 24 kHz PCM (~48 KB/s), so a
long selection in one message would be megabytes.

**Capability-gated** on `server_info.features.readAloud` (`COMPAT(readAloud)`, v0.2.5).
Hosts without it get no button at all — an upgrade prompt on every text selection would be
worse than the feature being absent. No fallback path.

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

To try it: open the workspace → diff-stat button in the top bar → expand a file → drag-select
a couple of diff lines. Agent output in a chat works too.

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
- **Markup sanitization is unit-tested only.** It was written after the last daemon restart,
  so it has never run against a live daemon. First thing to confirm after restarting:
  selecting a `<spoken-input>` block should speak only the inner text.

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
- **Assumed `getClientRects()` was one rect per line.** It is not — see the plan's traps
  section. The sub-agent caught this before it was written.
