import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("changing thinking then mode preserves a foreground Claude command", async () => {
  const logger = pino({ level: "silent" });
  const cwd = await mkdtemp(path.join(tmpdir(), "claude-settings-mid-turn-"));
  const daemon = await createTestPaseoDaemon({
    logger,
    agentClients: { claude: new ClaudeAgentClient({ logger }) },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "claude",
      model: "claude-haiku-5-5",
      modeId: "auto",
      thinkingOptionId: "low",
      cwd,
    });
    await client.subscribeAgentTimeline(agent.id, () => {}).ready;
    await client.sendMessage(
      agent.id,
      "Run exactly these three Bash commands in the foreground, one per tool call, in order: python3 -c \"from pathlib import Path; import time; Path('started').write_text('started'); time.sleep(20); print(1)\", then the same with print(2), then print(3). Then reply DONE.",
    );
    // A tool-call row is emitted before Claude's permission check finishes.
    // Wait for the command itself, so changing to acceptEdits cannot gate its start.
    await expect.poll(() => existsSync(path.join(cwd, "started")), { timeout: 90_000 }).toBe(true);
    const notice = await client.setAgentThinkingOption(agent.id, "medium");
    expect(notice).toEqual({ type: "warning", message: "Thinking level applies next turn" });
    await client.setAgentMode(agent.id, "acceptEdits");
    await expect
      .poll(
        async () => {
          const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
          return timeline.entries.some(
            ({ item }) =>
              item.type === "tool_call" &&
              item.detail.type === "shell" &&
              item.detail.command.includes("print(1)") &&
              item.status === "completed",
          );
        },
        { timeout: 45_000, interval: 100 },
      )
      .toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);
