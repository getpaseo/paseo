import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";

import type { AgentSteerOptions } from "../agent/agent-sdk-types.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

/** A daemon whose fake provider records each turn's prompt and holds the turns a test names. */
async function createQueueDaemon(options: { steer?: boolean; mcp?: boolean } = {}) {
  const prompts: string[] = [];
  const holds = new Map<string, PromiseWithResolvers<void>>();
  const releaseAll = () => {
    for (const held of holds.values()) held.resolve();
  };
  const ctx: DaemonTestContext = await createDaemonTestContext({
    mcpEnabled: options.mcp === true,
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      },
      beforeTurnComplete: (prompt) => holds.get(String(prompt))?.promise ?? Promise.resolve(),
      // An interrupted fake turn ends only when its hold is released.
      onInterrupt: releaseAll,
      ...(options.steer
        ? {
            steerActiveTurn: async (prompt: unknown, _options?: AgentSteerOptions) => {
              prompts.push(`steer:${String(prompt)}`);
              return { status: "accepted" as const };
            },
          }
        : {}),
    }),
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "message-queue-"));
  cleanups.push(async () => {
    releaseAll();
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });
  const agent = await ctx.client.createAgent({
    provider: "claude",
    cwd,
    title: "Queue recipient",
    modeId: "bypassPermissions",
  });
  const hold = (text: string) => {
    const held = Promise.withResolvers<void>();
    holds.set(text, held);
    return held;
  };
  const queue = (text: string) =>
    ctx.client.sendAgentMessage(agent.id, text, { activeTurnBehavior: "queue" });
  const queued = async () =>
    (await ctx.client.fetchAgent(agent.id))?.agent.queuedMessages?.map((entry) => entry.preview);
  return { ctx, agent, prompts, hold, queue, queued };
}

test("an idle agent starts a queued message at once", async () => {
  const { ctx, agent, prompts, queue } = await createQueueDaemon();

  await expect(queue("first")).resolves.toEqual({ disposition: "turn_started", revived: false });
  await ctx.client.waitForFinish(agent.id, 10_000);

  expect(prompts).toEqual(["first"]);
  expect(await ctx.client.fetchAgent(agent.id)).toMatchObject({
    agent: { status: "idle" },
  });
});

test("messages queued behind a running turn start one turn each, in order", async () => {
  const { ctx, agent, prompts, hold, queue, queued } = await createQueueDaemon();
  const work = hold("work");

  await expect(ctx.client.sendAgentMessage(agent.id, "work")).resolves.toMatchObject({
    disposition: "turn_started",
  });
  const receipts = [await queue("one"), await queue("two"), await queue("three")];

  expect(receipts).toEqual(
    [1, 2, 3].map((queuePosition) => ({
      disposition: "queued",
      queuePosition,
      revived: false,
    })),
  );
  expect(await queued()).toEqual(["one", "two", "three"]);
  expect(prompts).toEqual(["work"]);

  // A wait covers the queue: it returns after the last queued message's turn.
  const finished = ctx.client.waitForFinish(agent.id, 20_000);
  work.resolve();
  await expect(finished).resolves.toMatchObject({ status: "idle" });
  expect(prompts).toEqual(["work", "one", "two", "three"]);
  expect(await queued()).toBeUndefined();
});

test("a steer joins the running turn without reordering the queue", async () => {
  const { ctx, agent, prompts, hold, queue, queued } = await createQueueDaemon({ steer: true });
  const work = hold("work");
  await ctx.client.sendAgentMessage(agent.id, "work");
  await queue("one");

  await expect(
    ctx.client.sendAgentMessage(agent.id, "nudge", { activeTurnBehavior: "steer" }),
  ).resolves.toEqual({ disposition: "steered", revived: false });
  expect(await queued()).toEqual(["one"]);

  const finished = ctx.client.waitForFinish(agent.id, 20_000);
  work.resolve();
  await finished;
  expect(prompts).toEqual(["work", "steer:nudge", "one"]);
});

test("an interrupt replaces the running turn and the queue waits for the new turn", async () => {
  const { ctx, agent, prompts, hold, queue, queued } = await createQueueDaemon();
  hold("work");
  const urgent = hold("urgent");
  await ctx.client.sendAgentMessage(agent.id, "work");
  await queue("one");

  await expect(
    ctx.client.sendAgentMessage(agent.id, "urgent", { activeTurnBehavior: "interrupt" }),
  ).resolves.toEqual({ disposition: "interrupted", revived: false });
  expect(await queued()).toEqual(["one"]);
  expect(prompts).toEqual(["work", "urgent"]);

  const finished = ctx.client.waitForFinish(agent.id, 20_000);
  urgent.resolve();
  await finished;
  expect(prompts).toEqual(["work", "urgent", "one"]);
});

test("a canceled turn hands over to the queue", async () => {
  const { ctx, agent, prompts, hold, queue } = await createQueueDaemon();
  hold("work");
  await ctx.client.sendAgentMessage(agent.id, "work");
  await queue("after cancel");

  await ctx.client.cancelAgent(agent.id);

  await expect.poll(() => prompts, { timeout: 10_000 }).toEqual(["work", "after cancel"]);
});

test("archiving drops the queue, and a queued send revives the archived agent", async () => {
  const { ctx, agent, prompts, hold, queue } = await createQueueDaemon();
  hold("work");
  await ctx.client.sendAgentMessage(agent.id, "work");
  await queue("dropped");

  await ctx.client.archiveAgent(agent.id);
  expect(await readdir(path.join(ctx.daemon.paseoHome, "agent-message-queue"))).toEqual([]);

  await expect(queue("wake")).resolves.toEqual({ disposition: "turn_started", revived: true });
  await ctx.client.waitForFinish(agent.id, 10_000);
  expect(prompts).toEqual(["work", "wake"]);
  expect((await ctx.client.fetchAgent(agent.id))?.agent.archivedAt).toBeNull();
});

test("an agent queues through send_agent_prompt and the message keeps its provenance", async () => {
  const { ctx, agent, prompts, hold, queued } = await createQueueDaemon({ mcp: true });
  const work = hold("work");
  await ctx.client.sendAgentMessage(agent.id, "work");
  const caller = await ctx.client.createAgent({
    provider: "codex",
    cwd: tmpdir(),
    title: "Queue sender",
    modeId: "full-access",
  });
  const mcp = new Client({ name: "queue-sender", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${ctx.daemon.port}/mcp/agents?callerAgentId=${caller.id}`),
    ),
  );
  cleanups.push(() => mcp.close());

  const result = await mcp.callTool({
    name: "send_agent_prompt",
    arguments: {
      agentId: agent.id,
      prompt: "review when done",
      activeTurnBehavior: "queue",
      notifyOnFinish: false,
    },
  });

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    success: true,
    disposition: "queued",
    queuePosition: 1,
    revived: false,
  });
  expect(result.structuredContent).not.toHaveProperty("deliveryStatus");
  expect(await queued()).toEqual(["review when done"]);
  const status = await mcp.callTool({
    name: "get_agent_status",
    arguments: { agentId: agent.id },
  });
  expect(status.structuredContent).toMatchObject({
    snapshot: { queuedMessages: [{ preview: "review when done" }] },
  });

  work.resolve();
  await expect.poll(() => prompts.length, { timeout: 10_000 }).toBe(2);
  expect(prompts[1]).toContain('kind="agent-message"');
  expect(prompts[1]).toContain(`source-agent-id="${caller.id}"`);
  expect(prompts[1]).toContain("review when done");
});

async function startFixture(root: string) {
  const child = fork(
    fileURLToPath(new URL("../test-utils/finish-subscription-daemon.ts", import.meta.url)),
    [root, "{}", "{}"],
    {
      execArgv: ["--conditions=source", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => (output += data));
  child.stderr?.on("data", (data) => (output += data));
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message as { port: number; cwd: string }),
    once(child, "exit").then(([code]) => {
      throw new Error(`Fixture exited ${code}: ${output}`);
    }),
  ]);
  return { child, ...ready };
}

async function killFixture(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function readTurnPrompts(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "all-prompts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => String((JSON.parse(line) as { prompt: unknown }).prompt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("queued messages survive a daemon crash and start after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "message-queue-restart-"));
  const children: ChildProcess[] = [];
  let client: DaemonClient | undefined;
  try {
    const first = await startFixture(root);
    children.push(first.child);
    client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
    await client.connect();
    const agent = await client.createAgent({
      provider: "claude",
      cwd: first.cwd,
      title: "Restart recipient",
      modeId: "full-access",
    });
    await client.sendAgentMessage(agent.id, "HOLD_CHILD");
    for (const text of ["after restart 1", "after restart 2"])
      expect(
        await client.sendAgentMessage(agent.id, text, { activeTurnBehavior: "queue" }),
      ).toMatchObject({ disposition: "queued" });
    await client.close();
    client = undefined;
    await killFixture(first.child);

    const second = await startFixture(root);
    children.push(second.child);
    await expect
      .poll(() => readTurnPrompts(root), { timeout: 15_000 })
      .toEqual(["HOLD_CHILD", "after restart 1", "after restart 2"]);
  } catch (error) {
    console.error(await readFile(path.join(root, "fixture.log"), "utf8").catch(() => ""));
    throw error;
  } finally {
    await client?.close();
    for (const child of children.toReversed()) await killFixture(child);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
