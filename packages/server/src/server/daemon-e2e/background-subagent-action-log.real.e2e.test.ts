import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("background cards retain child actions after the parent finishes (#6253)", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-background-card-"));
  const logger = pino({ level: "silent" });
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
      model: "haiku",
      modeId: "bypassPermissions",
      cwd,
      title: "Background action log reproduction",
    });
    await client.sendMessage(
      agent.id,
      'In one message, call Agent twice with run_in_background true: first with subagent_type "general-purpose", description "List files", prompt "Run ls -1, then run sleep 20, then reply with the number of entries."; second with subagent_type "general-purpose", description "Print cwd", prompt "Run pwd, then run sleep 20, then reply with the path." After launching both, reply "launched" and end your turn immediately without waiting.',
    );
    await client.waitForFinish(agent.id, 180_000);
    const atFinish = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    await expect
      .poll(
        async () => {
          const { subagents } = await client.listProviderSubagents(agent.id);
          return subagents.length === 2 && subagents.every((child) => child.status === "completed");
        },
        { timeout: 180_000, interval: 1000 },
      )
      .toBe(true);
    const { subagents } = await client.listProviderSubagents(agent.id);
    const children = await Promise.all(
      subagents.map(async (child) => ({
        description: child.description,
        timeline: await client.fetchProviderSubagentTimeline(agent.id, child.id, {
          direction: "tail",
          limit: 0,
        }),
      })),
    );
    const final = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${daemon.port}`,
        "logs",
        agent.id,
      ],
      { env: { ...process.env, PASEO_HOME: daemon.paseoHome }, timeout: 30_000 },
    );
    expect(stdout).toContain("[Bash] ls -1");
    expect(stdout).toContain("[Bash] pwd");
    expect(
      atFinish.entries.filter(
        (row) => row.item.type === "tool_call" && row.item.detail?.type === "sub_agent",
      ),
    ).toHaveLength(2);
    const cards = final.entries
      .map((row) => row.item)
      .filter((item) => item.type === "tool_call" && item.detail?.type === "sub_agent");
    expect(cards).toHaveLength(2);
    for (const child of children) {
      expect(
        child.timeline.rows.some(
          (row) => row.item.type === "tool_call" && row.item.name === "Bash",
        ),
      ).toBe(true);
    }
    for (const card of cards) {
      expect(card.detail?.type === "sub_agent" ? card.detail.log : "").toContain("[Bash]");
    }
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 420_000);
