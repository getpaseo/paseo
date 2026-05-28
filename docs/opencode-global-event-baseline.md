# OpenCode Global Event Verification

Date: 2026-05-11

## Objective

Replace the OpenCode provider's per-directory `/event` stream with OpenCode's `/global/event` stream and remove the EOF polling recovery path that was added for the `/event` regression.

## Environment

- `opencode --version`: `1.14.46`
- `which opencode`: `/Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/opencode`
- `node --version`: `v22.20.0`
- `npm --version`: `10.9.3`

Each OpenCode test file was run independently with:

```bash
/opt/homebrew/bin/timeout 420s npx vitest run <file> --maxWorkers=1
```

## Baseline

Before the provider change, the OpenCode matrix had 16 passing files and 4 failing files:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: Vitest reports "No test suite found in file".
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`: `plan mode blocks edits while build mode can write files` did not observe a completed tool call.
- `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`: brittle unavailable-model assertion received an auth failure from the upstream API.
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: timed out waiting for an interrupted sleep tool call, even though the recent bash tool call status was `failed`.

## Post-Change Result

After switching to `/global/event`, removing polling recovery, and replacing the brittle initial-prompt model case with `opencode/big-pickle`, the OpenCode matrix had 18 passing files and 2 baseline-equivalent failing files:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: unchanged; Vitest still reports "No test suite found in file".
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: unchanged; still times out after the interrupted sleep tool call is already marked `failed`.

The previously failing provider unit file now passes, and `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts` passes with `opencode/big-pickle`.

One live reasoning-dedup matrix run returned no reasoning content; an immediate targeted rerun passed. This appears model-output dependent rather than related to the event-stream change.

## Focused Verification

- `npm run typecheck`
- `npm run lint`
- `git diff --check`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.error-handling.real.e2e.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts --maxWorkers=1`
