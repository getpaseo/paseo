import { OpenCodeRuntimeClient } from "./opencode/runtime-client.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { expect, test } from "vitest";

import { execCommand } from "../../../utils/spawn.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { PaseoToolCatalog } from "../tools/types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";
import {
  drainPersistedTimeline,
  readAssistantText,
  requireSessionId,
} from "./opencode/test-utils/v2-local-e2e-helpers.js";

test("real OpenCode server persists provider permissions across creation and resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-permissions-"));
  const cwd = path.join(root, "repo");
  const logger = createTestLogger();
  const manager = new OpenCodeServerManager({ logger, resolveHomeDir: () => root });
  const client = new OpenCodeAgentClient(logger, undefined, { serverManager: manager });
  let session: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>> | undefined;
  let inspection: Awaited<ReturnType<OpenCodeServerManager["acquireCurrent"]>> | undefined;

  try {
    await mkdir(cwd);
    session = await client.createSession({
      provider: "opencode",
      cwd,
      providerOptions: { permission: { external_directory: "allow" } },
    });
    inspection = await manager.acquireCurrent();
    const sdk = createOpencodeClient({ baseUrl: inspection.server.url, directory: cwd });
    async function readPermission(sessionId: string) {
      const response = await sdk.session.get({ sessionID: sessionId, directory: cwd });
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.data?.permission;
    }
    const handle = session.describePersistence()!;
    expect(await readPermission(handle.sessionId)).toEqual([
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);

    await session.close();
    // OpenCode appends session-update rules and the last matching rule wins, so a resume
    // with a different policy leaves both entries in order.
    session = await client.resumeSession(handle, {
      providerOptions: { permission: { external_directory: "deny" } },
    });
    expect(await readPermission(handle.sessionId)).toEqual([
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ]);
  } finally {
    await inspection?.release();
    await session?.close();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

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
      {
        provider: "opencode",
        cwd: firstCwd,
        model: process.env.OPENCODE_TEST_MODEL ?? "opencode/big-pickle",
        modeId: "build",
      },
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

    // Keep the prompt assertions independent of asynchronous events from the direct shell API.
    await first.close();
    first = await client.createSession(
      {
        provider: "opencode",
        cwd: firstCwd,
        model: process.env.OPENCODE_TEST_MODEL ?? "opencode/big-pickle",
        modeId: "build",
      },
      {
        agentId: "real-agent-one",
        env: { PASEO_AGENT_ID: "real-agent-one", PASEO_AGENT_CWD: firstCwd },
        paseoTools: firstTools,
      },
      { persistSession: false },
    );
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

test("v2 native tool bridge preserves caller identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-"));
  const logger = createTestLogger();
  const bridge = new OpenCodeBridge({ paseoHome: root, logger });
  const catalog = createCallerCatalog("paseo-v2-caller");
  bridge.setManifestCatalog(catalog);
  await bridge.start();
  const client = new OpenCodeV2AgentClient({ logger, bridge });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  try {
    session = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
        featureValues: { auto_accept: true },
      },
      { agentId: "paseo-v2-caller", paseoTools: catalog, env: { PASEO_TEST_SCOPE: "V2_ENV_OK" } },
      { persistSession: false },
    );
    const result = await session.run(
      "Call the paseo_report_caller_agent_id tool once, then reply with its exact result. Do not use any other tools.",
    );
    expect(readAssistantText(result.timeline)).toContain("paseo-v2-caller");
    const environment = await session.run(
      "Use the shell tool to run printf '%s' \"$PASEO_TEST_SCOPE\", then reply with its output.",
    );
    expect(environment.finalText).toContain("V2_ENV_OK");
    expect(result.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          name: "paseo_report_caller_agent_id",
          status: "completed",
        }),
      ]),
    );
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test.each([
  {
    major: 1,
    package: "opencode-ai@1.14.46",
    windowsPackage: "opencode-windows",
    expectedTimeline: [],
    expectedInitialTimeline: undefined,
    expectedNotices: undefined,
  },
  {
    major: 2,
    package: "@opencode/cli@2.0.10",
    windowsPackage: "@opencode/cli-windows",
    expectedTimeline: [
      { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
    ],
    expectedInitialTimeline: [
      expect.objectContaining({
        item: { type: "notification", level: "info", message: "This chat uses OpenCode v2." },
      }),
    ],
    expectedNotices: [expect.objectContaining({ major: 2 })],
  },
])(
  "versioned runtime v$major discovers models and preserves a native session handle",
  async ({
    package: cliPackage,
    windowsPackage,
    expectedTimeline,
    expectedInitialTimeline,
    expectedNotices,
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-versioned-"));
    const client = new OpenCodeRuntimeClient(createTestLogger(), {
      command: {
        mode: "replace",
        argv: [
          process.platform === "win32"
            ? path.join(
                root,
                "node_modules",
                `${windowsPackage}-${process.arch}`,
                "bin",
                "opencode.exe",
              )
            : path.join(root, "node_modules", ".bin", "opencode"),
        ],
      },
      env: {
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    });
    let original: Awaited<ReturnType<typeof client.createSession>> | undefined;
    let resumed: Awaited<ReturnType<typeof client.resumeSession>> | undefined;
    try {
      await execCommand(
        "npm",
        ["install", "--prefix", root, "--no-audit", "--no-fund", cliPackage],
        {
          cwd: root,
          timeout: 180_000,
        },
      );
      const catalog = await client.fetchCatalog({ scope: "workspace", cwd: root, force: true });
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.modes.map((mode) => mode.id)).toContain("build");
      original = await client.createSession(
        { provider: "opencode", cwd: root, modeId: "build" },
        undefined,
        { persistSession: false },
      );
      const handle = await original.describePersistence();
      expect(original.initialTimeline).toEqual(expectedInitialTimeline);
      expect(handle.metadata?.openCodeRuntimeNotices).toEqual(expectedNotices);
      resumed = await client.resumeSession(handle, { cwd: root });
      expect((await resumed.describePersistence()).nativeHandle).toBe(handle.nativeHandle);
      expect(
        (await drainPersistedTimeline(resumed)).map((event) =>
          event.type === "timeline" ? event.item : event,
        ),
      ).toEqual(expectedTimeline);
    } finally {
      await resumed?.close();
      await original?.close();
      await client.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
