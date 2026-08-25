# OpenCode 全局事件验证

日期：2026-05-11

## 目标

将 OpenCode 提供方的按目录 `/event` 流替换为 OpenCode 的 `/global/event` 流，并移除为 `/event` 回归添加的 EOF 轮询恢复路径。

## 环境

- `opencode --version`：`1.14.46`
- `which opencode`：`opencode`
- `node --version`：`v22.20.0`
- `npm --version`：`10.9.3`

每个 OpenCode 测试文件独立运行，使用：

```bash
/opt/homebrew/bin/timeout 420s npx vitest run <file> --maxWorkers=1
```

## 基线

在提供方变更之前，OpenCode 矩阵有 16 个通过文件和 4 个失败文件：

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`：Vitest 报告 "No test suite found in file"。
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`：`plan mode blocks edits while build mode can write files` 未观察到完成的工具调用。
- `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`：脆弱的不可用模型断言收到了来自上游 API 的认证失败。
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`：等待被中断的 sleep 工具调用超时，尽管最近的 bash 工具调用状态已是 `failed`。

## 变更后结果

在切换到 `/global/event`、移除轮询恢复并将脆弱的初始提示模型用例替换为 `opencode/big-pickle` 后，OpenCode 矩阵有 18 个通过文件和 2 个与基线等效的失败文件：

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`：未变；Vitest 仍然报告 "No test suite found in file"。
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`：未变；在被中断的 sleep 工具调用已标记为 `failed` 后仍然超时。

之前失败的提供方单元文件现在通过，并且 `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts` 使用 `opencode/big-pickle` 后通过。

一次实时推理去重矩阵运行未返回推理内容；立即进行的针对性重跑通过。这似乎取决于模型输出，而非与事件流变更相关。

## 聚焦验证

- `npm run typecheck`
- `npm run lint`
- `git diff --check`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.error-handling.real.e2e.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts --maxWorkers=1`
