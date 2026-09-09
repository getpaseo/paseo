import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { PaseoToolCatalog } from "../tools/types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

test("real OpenCode server shares one process while shell.env stays session-scoped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-real-"));
  const firstCwd = path.join(root, "first");
  const secondCwd = path.join(root, "second");
  const logger = createTestLogger();
  const bridge = new OpenCodeBridge({ paseoHome: root, logger });
  await bridge.start();
  const firstTools = createCallerCatalog("real-agent-one");
  const secondTools = createCallerCatalog("real-agent-two");
  bridge.setManifestCatalog(firstTools);
  const manager = new OpenCodeServerManager({
    logger,
    resolveHomeDir: () => root,
    decorateServerEnv: (env) => bridge.decorateServerEnv(env),
  });
  const client = new OpenCodeAgentClient(logger, undefined, {
    serverManager: manager,
    bridge,
  });
  let first: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>> | undefined;
  let second: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>> | undefined;
  let inspection: Awaited<ReturnType<OpenCodeServerManager["acquireCurrent"]>> | undefined;

  try {
    await Promise.all([
      mkdir(firstCwd, { recursive: true }),
      mkdir(secondCwd, { recursive: true }),
    ]);
    first = await client.createSession(
      { provider: "opencode", cwd: firstCwd, model: "opencode/big-pickle", modeId: "build" },
      {
        agentId: "real-agent-one",
        env: { PASEO_AGENT_ID: "real-agent-one", PASEO_AGENT_CWD: firstCwd },
        paseoTools: firstTools,
      },
      { persistSession: false },
    );
    second = await client.createSession(
      { provider: "opencode", cwd: secondCwd },
      {
        agentId: "real-agent-two",
        env: { PASEO_AGENT_ID: "real-agent-two", PASEO_AGENT_CWD: secondCwd },
        paseoTools: secondTools,
      },
      { persistSession: false },
    );

    inspection = await manager.acquireCurrent();
    const sdk = createOpencodeClient({ baseUrl: inspection.server.url, directory: root });
    const [firstShell, secondShell] = await Promise.all([
      sdk.session.shell({
        sessionID: requireSessionId(first),
        directory: firstCwd,
        agent: "build",
        command: 'printf "%s|%s" "$PASEO_AGENT_ID" "$PASEO_AGENT_CWD"',
      }),
      sdk.session.shell({
        sessionID: requireSessionId(second),
        directory: secondCwd,
        agent: "build",
        command: 'printf "%s|%s" "$PASEO_AGENT_ID" "$PASEO_AGENT_CWD"',
      }),
    ]);

    expect(firstShell.error).toBeUndefined();
    expect(secondShell.error).toBeUndefined();
    expect(JSON.stringify(firstShell.data)).toContain(`real-agent-one|${firstCwd}`);
    expect(JSON.stringify(secondShell.data)).toContain(`real-agent-two|${secondCwd}`);
    expect(inspection.server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const agentResult = await first.run(
      [
        "Use the bash tool to run: env | grep -E '^(PASEO_AGENT_ID|PASEO_AGENT_CWD)='",
        "Then report both values in your response:",
        "AGENT=real-agent-one",
        `CWD=${firstCwd}`,
      ].join("\n"),
    );
    expect(agentResult.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", name: "bash", status: "completed" }),
      ]),
    );
    const envReport = readAssistantText(agentResult.timeline);
    expect(envReport).toContain("real-agent-one");
    expect(envReport).toContain(firstCwd);

    const callerResult = await first.run(
      [
        "Use the paseo_report_caller_agent_id tool to read your Paseo caller agent ID.",
        "Then report that ID in your response.",
      ].join("\n"),
    );
    expect(callerResult.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          name: "paseo_report_caller_agent_id",
          status: "completed",
        }),
      ]),
    );
    expect(readAssistantText(callerResult.timeline)).toContain("real-agent-one");
  } finally {
    await inspection?.release();
    await first?.close();
    await second?.close();
    await manager.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

function requireSessionId(session: { id: string | null }): string {
  if (!session.id) throw new Error("OpenCode session has no id");
  return session.id;
}

function createCallerCatalog(callerAgentId: string): PaseoToolCatalog {
  const tool = {
    name: "report_caller_agent_id",
    title: "Report Paseo caller agent ID",
    description: "Returns the caller agent ID assigned by Paseo.",
    inputSchema: {},
    async handler() {
      return { content: [{ type: "text", text: callerAgentId }] };
    },
  };
  const tools = new Map([[tool.name, tool]]);
  return {
    tools,
    getTool: (name) => tools.get(name),
    async executeTool(name, input, context) {
      const definition = tools.get(name);
      if (!definition) throw new Error(`Unknown tool: ${name}`);
      return definition.handler(input, context ?? {});
    },
  };
}

function readAssistantText(timeline: ReadonlyArray<{ type: string; text?: string }>): string {
  return timeline
    .flatMap((item) => (item.type === "assistant_message" ? [item.text ?? ""] : []))
    .join("");
}
