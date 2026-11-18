import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { startAgentRun } from "../agent-prompt.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient reporting an ACP agent's background work", () => {
  test("lists the agent's _paseo/background_work after its turn ends, and keeps its runtime, until it reports none", async () => {
    await withAgent("reports", async ({ manager, agentId, run }) => {
      await run("start a helper");

      // Another session's report, one without a list, and items with no id are dropped; no
      // item can be stopped, even one the agent offers as stoppable.
      expect(manager.getAgent(agentId)?.lifecycle).toBe("idle");
      expect(manager.listAgentBackgroundWork(agentId)).toEqual([
        {
          id: "shell-1",
          kind: "shell",
          description: "Run the tests",
          command: "npm test",
          startedAt: expect.any(String),
        },
        { id: "helper-1", kind: "other", description: null, startedAt: expect.any(String) },
      ]);
      expect(manager.getAgentBackgroundWorkSummary(agentId)).toEqual({ count: 2 });
      // the idle runtime cleanup keeps the runtime of an agent whose work still runs
      expect(await manager.getAgent(agentId)?.session?.canStopRuntime?.()).toBe(false);

      await run("finish");
      expect(manager.listAgentBackgroundWork(agentId)).toEqual([]);
      expect(manager.getAgentBackgroundWorkSummary(agentId)).toEqual({ count: 0 });
      expect(await manager.getAgent(agentId)?.session?.canStopRuntime?.()).toBe(true);
    });
  });

  test("an agent that never reports background work has no inventory, as before", async () => {
    await withAgent("silent", async ({ manager, agentId, run }) => {
      await run("start a helper");
      expect(manager.listAgentBackgroundWork(agentId)).toEqual([]);
      expect(manager.getAgentBackgroundWorkSummary(agentId)).toBeUndefined();
    });
  });
});

async function withAgent(
  mode: "reports" | "silent",
  body: (agent: {
    manager: AgentManager;
    agentId: string;
    run: (text: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-background-work-"));
  const scriptPath = path.join(dir, "fake-acp-agent.cjs");
  await writeFile(scriptPath, fakeACPAgentScript, "utf8");
  const logger = createTestLogger();
  const client = new GenericACPAgentClient({
    logger,
    command: [process.execPath, scriptPath, mode],
    waitForInitialCommands: false,
  });
  const manager = new AgentManager({ clients: { acp: client }, logger });
  const agent = await manager.createAgent({ provider: "acp", cwd: dir }, undefined, {
    workspaceId: undefined,
  });
  let turns = 0;
  manager.subscribe(
    (event) => {
      if (event.type === "agent_stream" && event.event.type === "turn_completed") turns += 1;
    },
    { agentId: agent.id, replayState: false },
  );
  const run = async (text: string) => {
    const before = turns;
    await startAgentRun(manager, agent.id, text, logger, {});
    await expect.poll(() => turns).toBe(before + 1);
    await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  };
  try {
    await body({ manager, agentId: agent.id, run });
  } finally {
    await manager.closeAgent(agent.id);
    await manager.flush();
    await rm(dir, { recursive: true, force: true });
  }
}

// An ACP agent whose turn "start a helper" leaves work running after it ends, and whose turn
// "finish" ends that work. With "reports" it tells Paseo with _paseo/background_work, first to
// another session and without a list (both to be ignored); with "silent" it never does.
const fakeACPAgentScript = `
const readline = require("node:readline");

const [mode] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function work(sessionId, items) {
  if (mode === "reports") write({ method: "_paseo/background_work", params: { sessionId, items } });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    case "session/new":
      write({ id: message.id, result: { sessionId: "session-1" } });
      return;
    case "session/prompt": {
      const text = params.prompt.map((block) => block.text ?? "").join("");
      if (text === "start a helper") {
        work("session-other", [{ id: "x", kind: "shell", description: "not mine" }]);
        work(params.sessionId, "npm test");
        work(params.sessionId, [
          { id: "shell-1", kind: "shell", description: "Run the tests", command: "npm test", canStop: true },
          { id: "", kind: "agent", description: "no id" },
          { kind: "agent", description: "no id either" },
          { id: "helper-1", description: null },
        ]);
      } else {
        work(params.sessionId, []);
      }
      write({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      if (message.id !== undefined) write({ id: message.id, result: {} });
  }
});
`;
