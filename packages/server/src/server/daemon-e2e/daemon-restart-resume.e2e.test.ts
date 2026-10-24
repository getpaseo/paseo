import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { PersistenceHandle } from "@getpaseo/protocol/messages";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-"));
}

describe("daemon restart resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("Codex agent survives daemon restart with persistence handle", async () => {
    const cwd = tmpCwd();
    const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Daemon Restart Test Agent",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(
        agent.id,
        `Remember this marker string for a test: "${marker}".`,
      );

      const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();
      expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

      const handle = afterRemember.final!.persistence as PersistenceHandle;

      await ctx.cleanup();
      ctx = await createDaemonTestContext();

      const resumed = await ctx.client.resumeAgent(handle);
      await ctx.client.sendMessage(
        resumed.id,
        "What was the marker string I asked you to remember earlier?",
      );

      const afterRecall = await ctx.client.waitForFinish(resumed.id, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final?.persistence).toBeTruthy();
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      await ctx.client.deleteAgent(resumed.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

// These run in separate OS processes so SIGKILL cannot invoke daemon shutdown hooks.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

async function restartFixture(root: string) {
  const child = fork(
    fileURLToPath(new URL("../test-utils/finish-subscription-daemon.ts", import.meta.url)),
    [root],
    {
      execArgv: ["--conditions=source", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data;
  });
  child.stderr?.on("data", (data) => {
    output += data;
  });
  const ready = await Promise.race([
    once(child, "message").then(
      ([message]) => message as { port: number; paseoHome: string; cwd: string },
    ),
    once(child, "exit").then(([code]) => {
      throw new Error(`Fixture exited ${code}: ${output}`);
    }),
  ]);
  return { child, ...ready };
}
async function stopFixture(child: ChildProcess, abrupt: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (abrupt) child.kill("SIGKILL");
  else child.send("stop");
  await exited;
}
async function readPrompts(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "parent-prompts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test.each([false, true])(
  "durable finish subscriptions recover a running child after restart (abrupt=%s)",
  async (abrupt) => {
    const root = await mkdtemp(path.join(tmpdir(), "durable-finish-process-"));
    const processes: ChildProcess[] = [];
    let client: DaemonClient | undefined;
    let mcp: Client | undefined;
    try {
      const first = await restartFixture(root);
      processes.push(first.child);
      client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const parent = await client.createAgent({
        provider: "claude",
        cwd: first.cwd,
        title: "Durable parent",
        modeId: "full-access",
      });
      mcp = new Client({ name: "durable-parent", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${first.port}/mcp/agents?callerAgentId=${parent.id}`),
        ),
      );
      const result = await mcp.callTool({
        name: "create_agent",
        arguments: {
          provider: "claude/claude-test",
          title: "Held child",
          initialPrompt: "HOLD_CHILD",
        },
      });
      expect(result.isError).not.toBe(true);
      const childId = (result.structuredContent as { agentId: string }).agentId;
      expect((await client.fetchAgent(childId))?.agent.status).toBe("running");
      // Kill only after the running snapshot commits, so this exercises bootstrap repair
      // rather than recovery of the earlier idle snapshot while its write is pending.
      await expect
        .poll(
          async () =>
            (
              await new AgentStorage(path.join(first.paseoHome, "agents"), createTestLogger()).get(
                childId,
              )
            )?.lastStatus,
        )
        .toBe("running");
      expect(
        JSON.parse(await readFile(path.join(first.paseoHome, "finish-subscriptions.json"), "utf8")),
      ).toHaveLength(1);
      await mcp.close();
      mcp = undefined;
      await client.close();
      client = undefined;
      await stopFixture(first.child, abrupt);
      const second = await restartFixture(root);
      processes.push(second.child);
      await expect.poll(() => readPrompts(root), { timeout: 15000 }).toHaveLength(1);
      const prompts = await readPrompts(root);
      expect(prompts[0]).toContain(`Agent ${childId}`);
      expect(prompts[0]).toContain("was closed");
      await expect
        .poll(
          async () =>
            JSON.parse(
              await readFile(path.join(second.paseoHome, "finish-subscriptions.json"), "utf8"),
            ),
          { timeout: 5000 },
        )
        .toEqual([]);
      client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      expect((await client.fetchAgent(childId))?.agent.status).toBe("closed");
      await client.close();
      client = undefined;
      await stopFixture(second.child, false);
      const third = await restartFixture(root);
      processes.push(third.child);
      expect(await readPrompts(root)).toHaveLength(1);
      expect(
        JSON.parse(await readFile(path.join(third.paseoHome, "finish-subscriptions.json"), "utf8")),
      ).toEqual([]);
    } catch (error) {
      console.error(
        await readFile(path.join(root, "fixture.log"), "utf8").catch(() => "No fixture log"),
      );
      throw error;
    } finally {
      await mcp?.close();
      await client?.close();
      for (const child of processes.toReversed()) await stopFixture(child, true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
