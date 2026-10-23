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

## Open questions

- Warm-turn time to first spoken word on opus (target under 2 s) is not yet measured.
- `list_agents` and `read_agent_timeline` need the daemon to supply a `PaseoAgentsPort`; the adapter is not written.
- Barge-in drain: an interrupted session that does not reach its result within the drain timeout is rebuilt on the next turn. The rebuild path is covered only indirectly.
