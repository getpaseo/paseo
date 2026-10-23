# Demo: talk, spoken reply, action item, delegate

Env var names only; set the values locally. "Lab" is the GPU box running the speech servers (`lab/` in the voice-agent repo).

## What is verified and what is not

| Step                                                                                                          | Status                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm ci`, ordered workspace build                                                                             | verified (Linux, Node 22)                                                                              |
| Daemon starts, health OK, lab TTS and STT enabled with stock fallback                                         | verified                                                                                               |
| Lab TTS to STT roundtrip                                                                                      | verified (PASS)                                                                                        |
| Headless text turn (`--fake` and a live haiku turn on the subscription login), reply split into spoken chunks | verified                                                                                               |
| Action item: propose, refine, agree, announce line, launch via the dispatcher (dry run)                       | verified (`demo-delegate.mts`)                                                                         |
| Conversation agent and ledger driven from the daemon's voice session (mic to agent to ledger)                 | **not wired**: no launcher or `propose_action` tool yet; the pieces are exercised by the scripts below |
| App (web or desktop dev) talking to the daemon                                                                | not run headless; start commands below are from `package.json`                                         |

## Launch steps

```sh
git clone <pyrgos-paseo repo> && cd pyrgos-paseo   # or: git pull on main
npm ci
npm run build:server          # builds protocol, client, highlight, plugin, relay, server, cli in order
```

`npm run build:plugin` alone fails on a fresh tree (it needs the client built first); use `build:server`.

Daemon (terminal 1):

```sh
PASEO_LISTEN=127.0.0.1:6768 \
PASEO_LAB_TTS_URL=<ws url of lab TTS> \
PASEO_LAB_STT_URL=<ws url of lab STT> \
npm run dev:server
```

Unset `PASEO_LAB_*` and the stock provider is used. If the lab is down, the stock provider takes over (TTS before the first audio frame, STT at connect). Optional: `PASEO_LAB_TTS_VOICE`, `PASEO_LAB_CONNECT_TIMEOUT_MS`, `PASEO_LAB_TTS_IDLE_TIMEOUT_MS`. Check: `curl http://127.0.0.1:6768/api/health`, and the log shows "Lab TTS enabled" and "Lab STT enabled".

App (terminal 2), either:

```sh
npm run dev:app       # Expo web, talks to PASEO_LISTEN
npm run dev:desktop   # desktop shell
```

The ledger panel ("Action items") comes from `plugin-examples/pyrgos-action-ledger/` and reads `$ALCHEMIST_HARNESS/.agents/feedback/voice/*.ledger.jsonl`.

## Headless checks (run from `packages/server`)

1. Lab speech: `PASEO_LAB_TTS_URL=... PASEO_LAB_STT_URL=... npx tsx ../../scripts/pyrgos/lab-speech-roundtrip.mts` (exit 0 and `PASS`).
2. Text turn: `npx tsx scripts/pyrgos-conversation-turn.ts "what is in HANDOFF.md" --model haiku` (`--fake` needs no login). Optional env: `ALCHEMIST_HARNESS`, `ALCHEMIST_WORKSHOP`, `PYRGOS_CONVERSATION_MODEL`. Output: `speak` events, a `filler` first, then the reply in sentence chunks.
3. Action item and delegate: `ALCHEMIST_HARNESS=... PYRGOS_DISPATCH_CMD=<harness>/tools/dispatch/linux/dispatch.sh npx tsx ../../scripts/pyrgos/demo-delegate.mts`. Prints `state: agreed`, the announce line (written to `PYRGOS_DEMO_INBOX`, default a temp file) and the dispatcher's dry-run result. Set `PYRGOS_DEMO_LIVE=1` to run the worker for real; `PYRGOS_DEMO_CWD` picks its working directory.

## Open

- Wire `ConversationAgent` and the ledger into the daemon voice session, with the `AgentLauncher` from `DESIGN.md` 4.4 (route `dispatch` uses `PYRGOS_DISPATCH_CMD`).
- Run the app against the daemon and confirm the panel updates.
