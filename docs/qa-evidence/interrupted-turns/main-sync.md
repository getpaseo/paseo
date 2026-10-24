# Resolve overlap with upstream finish subscriptions

This revision merges upstream main `4fe006df86fc6d605383d81604fb77940813ae77`. Upstream #7683 (`21e7ccb03`) moved finish registration, durable storage, observation and retries into `agent/finish-subscriptions`. The conflicting prompt/create/tool paths now use that implementation. The old per-agent `finishNotifications` schema, callback setup and separate interruption-delivery loop are removed from this PR's implementation.

The remaining behavior is scoped to interruption state: repair stale local running/initializing records as errors before the official finish-subscription service starts, preserve error/attention on resume, and retain interruptions across clean daemon shutdown. Archived agents and daemon-owned Hub executions retain the upstream closed-state policy.

## Reproduction and verification

The previously failing Hub shutdown test was reproduced locally: it expected `closed` and received `error`. A fast bootstrap regression also failed when recovery classified an owned execution as an interrupted local turn. The ownership boundary now preserves `closed`, and both regressions pass. The Hub test additionally checks that restart does not recreate disconnected execution intents.

A new isolated-daemon bootstrap test seeds a running child and an intent in the official `finish-subscriptions.json` store. Startup marks the child as an error without reopening its unavailable provider. The recipient's first provider startup fails; the official service retries, sends one error notification and removes the intent after acknowledged dispatch. This tests the integration with #7683 rather than retaining two notification services.

The bootstrap tests now allow bounded filesystem cleanup retries for Windows `EBUSY`. This cleanup change has only been run locally on macOS; Windows CI must confirm it.

Current focused results on macOS, Node 22.21.0:

| Suite                                     | Passed |
| ----------------------------------------- | -----: |
| bootstrap                                 |      6 |
| agent-loading                             |      4 |
| Hub disconnect/shutdown regression        |      1 |
| targeted bootstrap shutdown/startup smoke |      4 |
| Total                                     |     15 |

`npm run build:server`, `npm run typecheck`, `npm run lint`, `npm run format` and `npm run format:check` were run for the merged sources. See the `main-sync-*.txt` outputs and `commands.txt`. Full local suites were not run. Tests used temporary homes and loopback ports; the installed production daemon was not restarted or changed.

The earlier raw outputs without a `main-sync-` prefix describe commit `4fb6bf80e7773185f7451a217e0baf6618b23809`, before the upstream service existed. They remain as historical reproduction evidence and are not claimed as the current test run. New-head official CI status is recorded in the PR separately.
