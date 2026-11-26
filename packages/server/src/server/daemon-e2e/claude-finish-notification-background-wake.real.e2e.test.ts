import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { parseAgentMessage } from "../agent/agent-messages/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";

const CallToolResultSchema = z.object({
  structuredContent: z.object({ agentId: z.string() }),
});

async function createAgentAs(port: number, callerAgentId: string, args: Record<string, unknown>) {
  const url = new URL(`http://127.0.0.1:${port}/mcp/agents`);
  url.searchParams.set("callerAgentId", callerAgentId);
  const mcp = await experimental_createMCPClient({
    transport: new StreamableHTTPClientTransport(url),
  });
  try {
    const callTool = Reflect.get(mcp, "callTool").bind(mcp);
    const result = await callTool({ name: "create_agent", args });
    return CallToolResultSchema.parse(result).structuredContent.agentId;
  } finally {
    await mcp.close();
  }
}

describe("daemon E2E (real claude) - finish notification across a background wake-up", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  test("the caller hears the child is still working, then gets its autonomous final reply", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "daemon-real-claude-finish-wake-"));
    const callerPrompts: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: {
        ...createTestAgentClients({
          onStartTurn(prompt, config) {
            if (config.title === "Finish caller" && typeof prompt === "string")
              callerPrompts.push(prompt);
          },
        }),
        ...createRealProviderClients(["claude"], logger),
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const token = `FINAL_${Date.now().toString(36)}`;

    try {
      await client.connect();
      const caller = await client.createAgent({
        provider: "codex",
        cwd,
        title: "Finish caller",
        modeId: "full-access",
      });
      const childId = await createAgentAs(daemon.port, caller.id, {
        relationship: { kind: "subagent" },
        workspace: { kind: "current" },
        provider: "claude/haiku",
        title: "Background child",
        notifyOnFinish: true,
        settings: { modeId: "bypassPermissions" },
        initialPrompt: [
          "Use the Bash tool with run_in_background: true to run exactly: sleep 20",
          "Do not wait or poll for it.",
          "Reply immediately with exactly: SPAWNED",
          `When the background task completes later, reply with exactly: ${token}`,
        ].join(" "),
      });

      await vi.waitFor(() => expect(callerPrompts).toHaveLength(1), {
        timeout: 180_000,
        interval: 250,
      });
      const interim = parseAgentMessage(callerPrompts[0]!);
      expect(interim.source).toMatchObject({
        kind: "agent-notification",
        agentId: childId,
        event: "message",
      });
      expect(interim.text).toContain("ended its turn but is still working");
      expect(interim.text).toContain("background work that will wake it");

      await vi.waitFor(() => expect(callerPrompts).toHaveLength(2), {
        timeout: 180_000,
        interval: 250,
      });
      const final = parseAgentMessage(callerPrompts[1]!);
      expect(final.source).toMatchObject({
        kind: "agent-notification",
        agentId: childId,
        event: "finished",
      });
      expect(final.text).toContain("Background child) finished.");
      expect(final.text).toContain(token);
      expect(daemon.daemon.agentManager.getAgent(childId)?.lifecycle).toBe("idle");
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
