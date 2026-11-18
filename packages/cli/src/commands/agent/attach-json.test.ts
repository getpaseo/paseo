import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestPaseoDaemon } from "../../../../server/src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../../server/src/server/test-utils/daemon-client.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { createFollowJsonWriter } from "./logs.js";

const items: AgentTimelineItem[] = [
  { type: "user_message", text: "hello\n한국어", messageId: "u1", clientMessageId: "client1" },
  { type: "assistant_message", text: "answer", messageId: "a1" },
  { type: "reasoning", text: "thinking" },
  { type: "tool_call", callId: "c1", name: "example", status: "completed", error: null,
    detail: { type: "unknown", input: { x: [1, true, null] }, output: { result: "ok" } },
    metadata: { nested: { value: "retained" } } },
  { type: "todo", items: [{ text: "task", completed: false }] },
  { type: "error", message: "timeline error" },
  { type: "notification", level: "warning", message: "notice" },
  { type: "compaction", status: "completed", trigger: "auto", preTokens: 123 },
  { type: "plugin", id: "p1", pluginId: "example", kind: "card", version: 1, data: { x: [true, null] } },
  { type: "user_message", text: "ten" },
  { type: "user_message", text: "eleven" },
];

describe("attach JSON", () => {
  it("retains all variants, unknown types, nested fields and physical-line framing", () => {
    const received = [...items, { type: "future", nested: { x: [1, null] } } as unknown as AgentTimelineItem];
    const chunks: string[] = [];
    const writer = createFollowJsonWriter(undefined, (chunk) => chunks.push(chunk));
    for (const item of received) writer.push(item);
    writer.end();
    expect(chunks).toEqual(received.map((item) => `${JSON.stringify(item)}\n`));
    expect(chunks.join("").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(received);
  });

  it.each([
    ["attach", "--json"],
    ["agent", "attach", "--json"],
    ["attach", "--format", "json"],
    ["agent", "attach", "--format", "json"],
    ["attach", "-o", "json"],
    ["--json", "attach"],
    ["--format", "json", "agent", "attach"],
    ["attach", "--json", "--format", "table"],
  ])("streams history and live items with selectors %j", async (...args) => {
    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
      for (const item of items) await daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
      const history = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0, projection: "projected" });
      let stdout = "";
      let stderr = "";
      child = spawn(process.execPath, ["--conditions=source", "--import", "tsx",
        fileURLToPath(new URL("../../index.ts", import.meta.url)),
        "--host", `127.0.0.1:${daemon.port}`, ...args, agent.id],
        { env: { ...process.env, PASEO_HOME: daemon.paseoHome }, stdio: ["pipe", "pipe", "pipe"] });
      const exited = once(child, "exit");
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      await expect.poll(() => stderr, { timeout: 20_000 }).toContain("Attached to agent");
      expect(stdout.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(history.entries.map((entry) => entry.item));
      expect(history.entries.length).toBeGreaterThan(10);
      child.stdin?.end();
      const live = { type: "user_message", text: "live\nfragment" } satisfies AgentTimelineItem;
      await daemon.daemon.agentManager.appendTimelineItem(agent.id, live);
      await expect.poll(() => stdout, { timeout: 10_000 }).toContain(`${JSON.stringify(live)}\n`);
      child.kill("SIGINT");
      expect(await exited).toEqual([0, null]);
      expect(stdout.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([...history.entries.map((entry) => entry.item), live]);
    } finally {
      if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      await client.close();
      await daemon.close();
    }
  }, 60_000);
});
