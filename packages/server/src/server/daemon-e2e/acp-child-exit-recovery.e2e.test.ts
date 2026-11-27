import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function startAcpEchoDaemon(fixtureArgs: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-acp-child-exit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "acp-pids");
  const daemon = await createTestPaseoDaemon({
    logger: createTestLogger(),
    pluginsEnabled: false,
    mcpEnabled: false,
    providerOverrides: {
      "acp-echo": {
        extends: "acp",
        label: "ACP Echo",
        command: [
          process.execPath,
          path.resolve(import.meta.dirname, "acp-echo-fixture.cjs"),
          pidFile,
          ...fixtureArgs,
        ],
      },
    },
  });
  cleanups.push(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanups.push(() => client.close());
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const latestPid = async () => Number((await readFile(pidFile, "utf8")).trim().split("\n").at(-1));
  return { client, cwd: root, latestPid };
}

async function assistantReplies(client: DaemonClient, agentId: string): Promise<string[]> {
  const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
  return timeline.entries.flatMap(({ item }) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
}

test("an idle ACP agent whose process was killed answers the next message", async () => {
  const { client, cwd, latestPid } = await startAcpEchoDaemon();
  const agent = await client.createAgent({ provider: "acp-echo", cwd });
  await client.sendMessage(agent.id, "first");
  expect((await client.waitForFinish(agent.id, 10_000)).status).toBe("idle");

  const pid = await latestPid();
  process.kill(pid, "SIGKILL");
  await expect.poll(() => isRunning(pid)).toBe(false);

  await client.sendMessage(agent.id, "second");
  expect((await client.waitForFinish(agent.id, 10_000)).status).toBe("idle");
  expect(await assistantReplies(client, agent.id)).toEqual([
    expect.stringContaining("first"),
    expect.stringContaining("second"),
  ]);
  expect(await latestPid()).not.toBe(pid);
}, 60_000);

test("an ACP agent that cannot reopen its session keeps its history after its process was killed", async () => {
  const { client, cwd, latestPid } = await startAcpEchoDaemon(["no-load"]);
  const agent = await client.createAgent({ provider: "acp-echo", cwd });
  await client.sendMessage(agent.id, "first");
  expect((await client.waitForFinish(agent.id, 10_000)).status).toBe("idle");

  const pid = await latestPid();
  process.kill(pid, "SIGKILL");
  await expect.poll(() => isRunning(pid)).toBe(false);

  await expect(client.sendMessage(agent.id, "second")).rejects.toThrow(
    "ACP agent disconnected (signal SIGKILL)",
  );
  expect((await client.fetchAgent(agent.id))?.agent.status).toBe("error");
  expect(await assistantReplies(client, agent.id)).toEqual([
    "echo: first",
    "[System Error] ACP agent disconnected (signal SIGKILL)",
  ]);
}, 60_000);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
