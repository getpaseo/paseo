import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { PiRpcAgentClient } from "./providers/pi/agent.js";
import { FakePi } from "./providers/pi/test-utils/fake-pi.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
async function drainSessionEvents(): Promise<void> {
  for (let index = 0; index < 10_000; index++) await Promise.resolve();
}
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Pi subagent output");
}
afterEach(() => vi.useRealTimers());
describe("provider subagent lifecycle ownership", () => {
  test(
    "a delayed parent turn end preserves a Pi child until its provider settles it",
    { timeout: 15_000 },
    async () => {
      // Run the real Pi client and adapter with an injected runtime.
      const pi = new FakePi();
      const client = new PiRpcAgentClient({
        logger: pino({ level: "silent" }),
        runtime: pi,
        // The injected runtime owns execution; use an existing executable for the real availability
        // probe so this test does not depend on a Pi installation or replace a client method.
        runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
      });
      const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-subagent-poll-"));
      const manager = new AgentManager({
        clients: { pi: client },
        idFactory: () => AGENT_ID,
        logger: createTestLogger(),
      });
      try {
        await manager.createAgent({ provider: "pi", cwd: workdir }, AGENT_ID, {
          workspaceId: undefined,
        });
        const piSession = pi.latestSession();
        // An async spawn whose status directory never appears: every poll tick is a miss.
        piSession.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "subagent",
          args: { agent: "scout", task: "Inspect", async: true },
        });
        piSession.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "subagent",
          result: {
            details: {
              mode: "single",
              runId: "run-1",
              asyncId: "run-1",
              asyncDir: join(workdir, "gone"),
              results: [],
            },
          },
        });
        const row = () => manager.getProviderSubagent(AGENT_ID, "call-1");
        await waitFor(() => row()?.status === "running");

        // Model delayed delivery of the parent turn end, with no provider cancellation.
        // Only Date moves: the adapter's real polling interval has not expired its miss budget.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.now() + 60_000));
        piSession.emit({ type: "agent_start" });
        piSession.emit({ type: "agent_end" });
        await drainSessionEvents();
        expect(row()?.status).toBe("running");

        // The provider's completion notice, rather than elapsed time in the manager, settles it.
        piSession.emit({
          type: "message_end",
          message: {
            role: "custom",
            customType: "subagent-notify",
            content: `Background task completed: **scout**\nRetention-managed async directory: ${join(workdir, "gone")}`,
            display: true,
          },
        });
        await drainSessionEvents();
        expect(row()?.status).toBe("completed");
      } finally {
        try {
          await manager.closeAgent(AGENT_ID);
        } catch {
          // A createAgent failure leaves nothing to close; the workdir cleanup must still run.
        } finally {
          rmSync(workdir, { recursive: true, force: true });
        }
      }
    },
  );

  test("history replay preserves the async status supplied by Pi", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      // The injected runtime owns execution; use an existing executable for the real availability
      // probe so this test does not depend on a Pi installation or replace a client method.
      runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
    });
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-subagent-poll-"));
    const manager = new AgentManager({
      clients: { pi: client },
      idFactory: () => AGENT_ID,
      logger: createTestLogger(),
    });
    try {
      await manager.createAgent({ provider: "pi", cwd: workdir }, AGENT_ID, {
        workspaceId: undefined,
      });
      pi.latestSession().messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-replay",
              name: "subagent",
              arguments: { workflowScript: "return await runs.all([]);", async: true },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-replay",
          toolName: "subagent",
          content: [],
          details: {
            mode: "workflow",
            runId: "run-replay",
            asyncId: "run-replay",
            asyncDir: join(workdir, "gone"),
            results: [],
          },
        },
      ];
      await manager.hydrateTimelineFromProvider(AGENT_ID, { force: true });
      expect(manager.getProviderSubagent(AGENT_ID, "call-replay")?.status).toBe("running");
    } finally {
      await manager.closeAgent(AGENT_ID);
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
