# How it was built

Decision log for the Pyrgos additions to this fork. Ordered by build sequence, no dates. Each entry says what was decided, why, what was rejected and the consequence.

## Action-item ledger (MIC-750 ticket C)

**Decided:** a pure TypeScript state machine (`draft | refined | agreed | dropped`) with an injected store, announcer and launcher, in `packages/server/src/server/pyrgos/ledger/`. Agreement needs an explicit `agree(id, { confirmed: true })` and a complete item (scope, project, done-criteria).
**Who:** the orchestrator specified the ticket and the contract; Claude chose the details below.
**Why:** the voice agent must never act on a half-formed or merely overheard request; the guard lives in the ledger so no caller can skip it.
**Rejected:** shelling out to the Python `feed.py` (the brief says port the ideas); putting the launch call inside the ledger (it is injected so the design note can wire the dispatch lanes).
**Consequence:** the contract names `agree`; the ticket text names `confirm`. Only `agree` exists. A `confirm` name is a one-line alias if the brain wants it.
**Status:** verified, by `ledger.test.ts` (transitions, rejection of incomplete items, launch-error handling, reload).

## Ledger persistence in its own file

**Decided:** item changes append to `<session>.ledger.jsonl` (full item per row, last row per id wins on load). The transcript `<session>.jsonl` stays as the feed's speaker rows, so announce line numbers are unchanged.
**Who:** Claude.
**Why:** the transcript line number is what the announce line cites; mixing item snapshots into it would shift those numbers and break the contract with the Python feed.
**Rejected:** one combined file.
**Consequence:** two files per session; the panel reads only the ledger file.
**Status:** verified, by `feed.test.ts` and the fixture-driven panel test.

## Port of the feed (lock, announce, replies, turn gate)

**Decided:** `createVoiceSession.append` takes a lock file (`wx` create, stale after 10 seconds) plus an in-process queue so the line count and the write are atomic. Replies not spoken because the gate is busy stay queued rather than being dropped.
**Who:** Claude, porting MIC-749 `feed.py`.
**Why:** two writers in one process (and the Python feed in another) must not hand out the same line number.
**Rejected:** a synchronous spin lock (blocks the server's event loop).
**Consequence:** the lock is advisory and only protects writers that use the same lock file name.
**Status:** verified for concurrent same-process writers (test with 20 parallel appends); assumed for interleaving with the Python writer until both run against one session file.

## Panel as a plugin

**Decided:** the list UI is a directory-source Paseo plugin (`plugin-examples/pyrgos-action-ledger/`) polling one RPC; no core changes.
**Who:** Claude, following the plugin seam preference in the brief.
**Why:** keeps the fork's core diff at zero for this feature.
**Rejected:** a core panel; server push (polling at 2 seconds is enough for a list that changes on human timescales).
**Consequence:** the plugin carries its own copy of the item schema because plugins cannot import host server code; the two must be kept in step.
**Status:** verified for rendering from a fixture; assumed for loading inside a running daemon (not launched here).

## Voice panel talks to the provider through files

**Decided:** settings, capabilities and word timings pass between the panel and the TTS provider as three files in the voice directory (see `voice-panel.md`).
**Who:** Claude proposed; the orchestrator's brief required a settings panel and word highlight but the provider had no timestamp event yet.
**Why:** plugins cannot register speech providers or read the audio stream, and the file seam works the same on lab and PC.
**Rejected:** a core change to the speech pipeline; a websocket from the plugin to the provider.
**Consequence:** ticket D2 must write `voice-capabilities.json` and `*.words.jsonl` and read `voice-settings.json` per utterance, or the panel shows defaults and no highlight.
**Status:** verified for clamping, file round-trip and rendering from fixtures; assumed for live sync with a real provider and for Android rendering (neither run here).

## Open questions

- Will D2 adopt the file contract as written, or expose a server event the plugin can subscribe to instead?

- Which name does the brain call, `agree` or `confirm`?
- Does the design note (ticket A) want the ledger wired at server start, and where does the `launch` implementation live?
- Does the daemon discover plugins under `plugin-examples/` or only from a configured directory?

# How it was built (Pyrgos Paseo)

Entries are in build order, without dates. Each carries a status: verified (with evidence) or assumed (with what would settle it).

## Lab speech providers (MIC-750 D)

- **Decided:** speak and listen through the lab's local TTS/STT WebSockets by default, with Paseo's stock provider as the fallback. The orchestrator specified it; Claude chose the shape.
- **Shape:** new `providers/lab/` directory plus one call in `speech-runtime.ts` that wraps whatever the stock path built. Rejected: a new `SpeechProviderId` and config schema entries (touches core types, config persistence and the UI, and makes upstream merges harder). Consequence: lab is selected by env vars, not by the settings UI, and the effective-provider label for TTS still reads as the stock one.
- **Fallback:** TTS falls back only before the first audio frame, so a sentence never switches voice midway. STT falls back at `connect()` and resamples 16 kHz to the fallback's rate with linear interpolation.
- **Status:** verified. Provider tests with a fake loopback WebSocket server pass (13 tests). A headless script spoke "The quick brown fox jumps over the lazy dog." through the lab TTS and the lab STT returned the same text; first audio took 542 ms on that cold-ish call.
- **Status:** assumed. The settings UI and the "effective provider" readout do not know about the lab; settle by wiring a provider id once ticket A's design says where it should surface. Linear-interpolation resampling is adequate for speech recognition; settle with a fallback-path accuracy test against the stock STT.

## Open questions

- Should the lab become a first-class provider id in settings and the readiness snapshot?
- First-audio latency on the first call after idle (542 ms here, against 44 ms p50 measured warm in the lab docs): is the cause server warm-up or the new connection per sentence? A persistent TTS socket would settle it.

# How Pyrgos Paseo was built

Decision log for the voice conversation agent in this fork. Ordered by build sequence; no dates.

## Local Android and desktop builds (MIC-750 E)

- **Decided:** build the APKs locally with Gradle through scripted wrappers (`scripts/pyrgos/build-android.sh` and `.ps1`), not through EAS cloud. **Who:** the overseer set the ticket; Claude implemented.
- **Rejected:** EAS cloud (needs an account and signing credentials; the hard rules forbid both). Using the Android Studio JBR as the JDK: it is Java 25 here and the Gradle/React Native toolchain wants 17-21, so a user-local Temurin 21 is used instead.
- **Chosen:** the production APK is a release build signed with a throwaway debug keystore, generated outside git. It is for sideloading, not for stores.
- **Found by failing:** a first build died because npm blocks native-asset postinstalls (`allowScripts`) for `react-native-enriched-markdown` and `@shopify/react-native-skia`. The build script now runs those two itself.
- **Chosen:** the Windows desktop installer script is written but never run on the lab; the PC builds it.
- **Consequence:** one command per platform; the first lab build takes about 10 minutes for both variants.
- **Status:** verified for Android: both APKs built on the lab and `aapt2 dump badging` reports package `sh.paseo` for each; the PowerShell twin was run under `pwsh` on the lab. **Assumed:** install and launch on a device (none attached), and the Windows desktop build (untested on PC).

## Open questions

- Does the APK start and reach a daemon over the tailnet? Settle with `adb install` on a phone.
- Does `build-desktop.ps1` pass on the Windows PC? Settle with the PC-CHECK steps in the PR.

## 1. Design note first (MIC-750 A)

- **Decided:** write `docs/pyrgos/DESIGN.md` before B (conversation agent), C (ledger and overseer feed) and D (lab speech) start, so the three can be built in parallel against fixed interfaces.
- **Who:** the overseer session set the plan; Claude drafted the note.
- **Chosen:** a direct "voice brain" hook on `VoiceSession` instead of binding voice mode to a Paseo agent. **Rejected:** the stock path (agent turn plus MCP `speak` call per reply), because it adds latency against the 2 s target.
- **Chosen:** a new `lab` speech provider id, which needs a small edit to the closed enum in `speech-types.ts`. **Rejected:** a plugin-only route, because plugins cannot register speech providers (`packages/plugin/src/server/contracts.ts`).
- **Consequence:** about three small core edits; everything else is under `pyrgos/` and `plugins/pyrgos-ledger/`.
- **Status:** verified for the cited seams (files and symbols read in this checkout). The latency claim for the stock path is **assumed**; B settles it by measuring.

## Open questions

- Is the stock bound-agent path fast enough to drop core change 2? B measures time-to-first-audio.
- Does the ledger plugin need a core change to see the ledger, or is reading the shared JSONL enough?
