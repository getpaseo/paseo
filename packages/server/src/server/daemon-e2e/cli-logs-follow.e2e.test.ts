import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// A real daemon and CLI with a deterministic provider emitting two text chunks.
// The live Claude reproduction is recorded in the PR; this locks its CLI behavior.
test("logs --follow preserves the same assistant text as one-shot logs", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let follow: ReturnType<typeof spawn> | undefined;
  let stdout = "";
  let stderr = "";
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "claude",
      cwd: daemon.paseoHome,
      title: "Follow transcript regression",
      modeId: "bypassPermissions",
    });
    follow = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${daemon.port}`,
        "logs",
        "--follow",
        agent.id,
        "--tail",
        "0",
        "--filter",
        "assistant_message",
      ],
      {
        env: { ...process.env, PASEO_HOME: daemon.paseoHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(follow, "exit");
    follow.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    follow.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await expect
      .poll(
        () => {
          if (follow?.exitCode !== null) {
            throw new Error(`CLI exited before following logs: ${stderr}`);
          }
          return stdout;
        },
        { timeout: 20_000 },
      )
      .toContain("Following logs");
    await client.sendMessage(agent.id, "respond with exactly: paseo-pr-cycle 한국어 보고서");
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
    const transcript = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 100,
      projection: "projected",
    });
    const assistantText = transcript.entries
      .filter((row) => row.item.type === "assistant_message")
      .map((row) => (row.item.type === "assistant_message" ? row.item.text : ""))
      .join("");
    expect(assistantText).not.toBe("");
    // Completion closes the message while follow mode is still running.
    // Then stop through the CLI's normal signal path.
    await expect.poll(() => stdout, { timeout: 10_000 }).toContain(`${assistantText.trim()}\n`);
    follow.kill("SIGINT");
    await exited;
    const output = stdout.slice(stdout.indexOf("---\n") + 4).trim();
    expect(output, stderr).toBe(assistantText.trim());
  } finally {
    follow?.kill("SIGTERM");
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("omitted after limit pages forward while explicit zero preserves complete CLI history", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
    const initial = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const cursor = { epoch: initial.epoch, seq: initial.window.maxSeq };
    for (let index = 0; index < 451; index++) {
      await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: String(index),
      });
    }
    const first = await client.fetchAgentTimeline(agent.id, { direction: "after", cursor });
    expect(first.entries).toHaveLength(200);
    expect(first.hasNewer).toBe(true);
    expect(first.endCursor).toEqual({ epoch: cursor.epoch, seq: cursor.seq + 200 });
    const second = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: first.endCursor!,
    });
    const third = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: second.endCursor!,
    });
    expect(second.entries).toHaveLength(200);
    expect(third.entries).toHaveLength(51);
    expect(third.hasNewer).toBe(false);
    expect(
      [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.item),
    ).toEqual(
      Array.from({ length: 451 }, (_, index) => ({ type: "user_message", text: String(index) })),
    );
    const allAfter = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor,
      limit: 0,
    });
    const allTail = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    expect(allAfter.entries).toHaveLength(451);
    expect(allAfter.hasNewer).toBe(false);
    expect(allTail.entries).toHaveLength(initial.entries.length + 451);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
