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
