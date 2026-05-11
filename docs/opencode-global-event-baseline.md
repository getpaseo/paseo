# OpenCode Global Event Baseline

Date: 2026-05-11
Worktree: `/Users/moboudra/.paseo/worktrees/1luy0po7/fix-opencode-global-event-stream`
Branch: `fix-opencode-global-event-stream`

## Objective

Replace the OpenCode provider's per-directory `/event` stream dependency with OpenCode's `/global/event` stream and remove the EOF polling recovery code added for the `/event` regression.

## Baseline Commands

Environment:

- `opencode --version`: `1.14.46`
- `which opencode`: `/Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/opencode`
- `node --version`: `v22.20.0`
- `npm --version`: `10.9.3`

Command shape:

```bash
/opt/homebrew/bin/timeout 420s npx vitest run <file> --maxWorkers=1 --minWorkers=1
```

Full baseline log: `/tmp/paseo-opencode-baseline.log`
Baseline summary: `/tmp/paseo-opencode-baseline.tsv`

## Baseline Results

| Result | Seconds | Test file                                                                                   |
| ------ | ------: | ------------------------------------------------------------------------------------------- |
| FAIL   |       1 | `packages/cli/tests/e2e/opencode-invalid-model.test.ts`                                     |
| PASS   |       4 | `packages/server/src/server/agent/opencode-reasoning.e2e.test.ts`                           |
| PASS   |       3 | `packages/server/src/server/agent/providers/opencode-agent-commands.e2e.test.ts`            |
| PASS   |       4 | `packages/server/src/server/agent/providers/opencode-agent-commands.real.e2e.test.ts`       |
| PASS   |      55 | `packages/server/src/server/agent/providers/opencode-agent.error-handling.real.e2e.test.ts` |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode-agent.full-access.test.ts`             |
| PASS   |       0 | `packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts`     |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode-agent.slash-command-timeout.test.ts`   |
| FAIL   |      53 | `packages/server/src/server/agent/providers/opencode-agent.test.ts`                         |
| PASS   |      11 | `packages/server/src/server/agent/providers/opencode-assistant-message.real.e2e.test.ts`    |
| PASS   |      12 | `packages/server/src/server/agent/providers/opencode-reasoning-dedup.real.e2e.test.ts`      |
| PASS   |       0 | `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`                |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode/event-translator.test.ts`              |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts`              |
| PASS   |       5 | `packages/server/src/server/daemon-e2e/opencode-custom-agents.real.e2e.test.ts`             |
| FAIL   |      13 | `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`       |
| PASS   |      16 | `packages/server/src/server/daemon-e2e/opencode-invalid-mode.real.e2e.test.ts`              |
| PASS   |      15 | `packages/server/src/server/daemon-e2e/opencode-invalid-model.real.e2e.test.ts`             |
| PASS   |      23 | `packages/server/src/server/daemon-e2e/opencode-plan-and-questions.real.e2e.test.ts`        |
| FAIL   |      65 | `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`            |

Baseline failure notes:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: Vitest reports "No test suite found in file"; this is not an OpenCode provider behavior failure.
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`: `OpenCodeAgentClient > plan mode blocks edits while build mode can write files` failed because no completed tool call was observed at `opencode-agent.test.ts:304`.
- `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`: `waitForFinish surfaces a terminal error when zai/glm-5.1 enters a fatal retry loop` received `"authentication failed"` instead of an insufficient-balance/resource-package message.
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: `explicit interrupt during sleep tool call still allows the next turn to complete` timed out even though the recent bash tool call status was `failed`.

## Post-Change Results

Full post-change log: `/tmp/paseo-opencode-postchange-final2.log`
Post-change summary: `/tmp/paseo-opencode-postchange-final2.tsv`

| Result | Seconds | Test file                                                                                   |
| ------ | ------: | ------------------------------------------------------------------------------------------- |
| FAIL   |       0 | `packages/cli/tests/e2e/opencode-invalid-model.test.ts`                                     |
| PASS   |       4 | `packages/server/src/server/agent/opencode-reasoning.e2e.test.ts`                           |
| PASS   |       3 | `packages/server/src/server/agent/providers/opencode-agent-commands.e2e.test.ts`            |
| PASS   |       4 | `packages/server/src/server/agent/providers/opencode-agent-commands.real.e2e.test.ts`       |
| PASS   |       4 | `packages/server/src/server/agent/providers/opencode-agent.error-handling.real.e2e.test.ts` |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode-agent.full-access.test.ts`             |
| PASS   |       0 | `packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts`     |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode-agent.slash-command-timeout.test.ts`   |
| PASS   |      48 | `packages/server/src/server/agent/providers/opencode-agent.test.ts`                         |
| PASS   |      11 | `packages/server/src/server/agent/providers/opencode-assistant-message.real.e2e.test.ts`    |
| PASS   |      11 | `packages/server/src/server/agent/providers/opencode-reasoning-dedup.real.e2e.test.ts`      |
| PASS   |       0 | `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`                |
| PASS   |       1 | `packages/server/src/server/agent/providers/opencode/event-translator.test.ts`              |
| PASS   |       0 | `packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts`              |
| PASS   |       5 | `packages/server/src/server/daemon-e2e/opencode-custom-agents.real.e2e.test.ts`             |
| FAIL   |      12 | `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`       |
| PASS   |       5 | `packages/server/src/server/daemon-e2e/opencode-invalid-mode.real.e2e.test.ts`              |
| PASS   |       5 | `packages/server/src/server/daemon-e2e/opencode-invalid-model.real.e2e.test.ts`             |
| PASS   |      20 | `packages/server/src/server/daemon-e2e/opencode-plan-and-questions.real.e2e.test.ts`        |
| FAIL   |      69 | `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`            |

Post-change failure notes:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: unchanged from baseline; Vitest reports "No test suite found in file".
- `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`: unchanged from baseline; the provider returned `authentication failed` while the test still expects an insufficient-balance/resource-package/recharge message.
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: unchanged from baseline; it timed out waiting for the interrupted sleep tool call even though the recent bash tool call status was `failed`.
