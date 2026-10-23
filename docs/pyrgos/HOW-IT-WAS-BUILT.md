# How it was built (Pyrgos Paseo)

A formal log of the Pyrgos additions to this fork, in build order. Each entry says what was decided, why, what was rejected and the consequence. No dates.

## Conversation-agent server module (MIC-750 B)

**Decision:** Add `packages/server/src/server/pyrgos/conversation-agent/` as a self-contained module, with no change to Paseo core. The brain sits behind a small `Brain` interface; the production brain (`SdkBrain`) is one warm Claude Agent SDK session on the subscription login, and tests use a fake. **Who:** the orchestrator specified the module; Claude Sonnet 5.5 designed and built it.

**Why:** The voice agent must answer plain turns in under two seconds, so the session stays warm (streaming input, partial messages) instead of spawning per turn. The `Brain` seam keeps the realtime loop testable without a login.

**Ported from the earlier Python voice agent (idea for idea, not shelled out):** sentence chunker with an early first chunk; redacting context builder (handoff, plan, open tickets, framed as data); the filler rule ("One sec." at once for tool-looking questions, or for turns of four or more words on sonnet and opus, else at the first tool call); barge-in with a generation counter; a read-only tool allowlist; `ANTHROPIC_API_KEY` stripped from the subprocess environment so only the subscription login is used.

**Rejected:** a new voice-session class inside core (large diff, hard to merge upstream); a per-turn SDK `query` (process start on every turn); calling the Python repo (two runtimes).

**Output contract:** the module emits `assistant_chunk` (transcript text), `speak` (text for the speech providers, which produce `audio_output`), `turn_end`, `interrupted` and `error`. Wiring those to the voice session host is left to the speech-provider ticket; this module does not touch `voice-session.ts`.

**Tools:** `status`, `open_tickets`, `read_file`, `search`, plus `list_agents` and `read_agent_timeline` when the daemon passes a `PaseoAgentsPort`. All read only. File reads are confined to the configured roots, follow symlinks to their real path, refuse secret-named files, and redact output.

**Status:** verified. Unit tests run against a fake SDK (agent, chunker, context, redaction, tools, brain). A headless script (`packages/server/scripts/pyrgos-conversation-turn.ts`) drove one live text turn on haiku through the subscription login: the filler came out at once and the reply followed; the cold first reply took about 2.4 s including session start. Warm-turn latency on opus is **assumed** under two seconds and still needs measuring.

**Review fixes (Codex REQUEST_CHANGES, orchestrator relayed; Claude fixed):** (1) two transcripts during one turn both passed `bargeIn()`; now the newest ticket wins, barge-in interrupts a running turn once, and turns never overlap. (2) `SdkBrain.runTurn` treated every SDK result as success; now an error subtype or `is_error` throws, which the agent emits as an `error` event (an interrupted turn's error result is ignored by design). (3) `read_file` read the whole file before the cap; now it reads at most 4 bytes per capped character. (4) `status` returned the context uncapped; now redacted and capped like the other tools. **Status:** verified by new unit tests for each (35 tests pass, lint and typecheck clean).

**Review fixes, round 2 (Codex, orchestrator relayed; Claude fixed):** (1) a hung SDK turn never reached its result, so barge-in waited forever; `interruptTimeoutMs` now abandons the turn and the session is rebuilt on the next one. (2) the credential denylist (`.npmrc`, `.netrc` and similar) was checked on the requested path only; it now also checks the resolved real path, so a symlink cannot reach a secret file. **Status:** verified by two new unit tests (37 pass, lint and typecheck clean).

**Review fixes, round 3 (Codex; Claude fixed):** (1) a rejected `brain.interrupt()` escaped the race in `settle()` and blocked the replacement turn; the rejection is now swallowed and the turn is abandoned at the timeout. (2) the secret-name pattern missed multi-suffix names such as `secrets.production.json`; any `secret(s)` or `credential(s)` name with any suffix is now blocked. **Status:** verified by a new agent test and extended tool tests (38 pass, lint and typecheck clean).

**Review fixes, round 5 (Codex; Claude fixed):** (1) `close()` now marks the agent closed first, so a transcript queued behind the interrupted turn cannot start a new one on a closing brain. (2) `SdkBrain` drops its session when `iterator.next()` throws, so the next turn starts a fresh one. (3) `search` skips a file whose read fails. Non-blocking: `..notes.md` no longer counts as an escape from the root; the markdown cleaner keeps `_` and `*` inside identifiers. **Status:** verified by new tests for each (44 pass, lint and typecheck clean).

**Review fixes, round 6 (Codex; Claude fixed):** (1) the system prompt said the brain never dispatches, which contradicted the demo's delegate action; it now says delegation is proposed through the ledger and confirmed and launched only on the ledger's confirm and launch path. (2) URL credentials whose password contained `@` left part of the password and host visible; the pattern now runs to the last `@` before the path. (3) `read_file` now also denies `.aws/*`, `.git/*`, `.kube/config` and `.config/gh/hosts.yml`, beside the existing `.ssh` and `.gnupg`. **Status:** verified by new tests (46 pass, lint and typecheck clean).

## Open questions

- Warm-turn time to first spoken word on opus (target under 2 s) is not yet measured.
- `list_agents` and `read_agent_timeline` need the daemon to supply a `PaseoAgentsPort`; the adapter is not written.
- Barge-in drain: an interrupted session that does not reach its result within the drain timeout is rebuilt on the next turn. The rebuild path is covered only indirectly.

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
