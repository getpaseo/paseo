import { execCommand } from "../../../utils/spawn.js";
import { z } from "zod";
import { OpenCodeRuntimeClient } from "./opencode/runtime-client.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { PaseoToolCatalog } from "../tools/types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

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

test("versioned runtime discovers models and preserves a native session handle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-versioned-"));
  const client = new OpenCodeRuntimeClient(createTestLogger());
  let original: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof client.resumeSession>> | undefined;
  try {
    const catalog = await client.fetchCatalog({ scope: "workspace", cwd: root, force: true });
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.modes.map((mode) => mode.id)).toContain("build");
    original = await client.createSession(
      { provider: "opencode", cwd: root, modeId: "build" },
      undefined,
      { persistSession: false },
    );
    const handle = await original.describePersistence();
    resumed = await client.resumeSession(handle, { cwd: root });
    expect((await resumed.describePersistence()).nativeHandle).toBe(handle.nativeHandle);
    const history = [];
    for await (const item of resumed.streamHistory()) history.push(item);
    expect(history).toEqual([]);
  } finally {
    await resumed?.close();
    await original?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("v2 structured output survives history and does not affect the next ordinary turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-schema-"));
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  try {
    session = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
      },
      undefined,
      { persistSession: false },
    );
    const result = await session.run("Compute six times seven and return the answer.", {
      outputSchema: {
        type: "object",
        properties: { answer: { type: "integer", const: 42 } },
        required: ["answer"],
        additionalProperties: false,
      },
    });
    expect(JSON.parse(result.finalText)).toEqual({ answer: 42 });
    const history = [];
    for await (const event of session.streamHistory!()) history.push(event);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ type: "assistant_message", text: result.finalText }),
        }),
      ]),
    );
    const ordinary = await session.run("Reply with exactly ORDINARY, without using tools.");
    expect(ordinary.finalText.trim()).toBe("ORDINARY");
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("v2 handles live tool approvals and questions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-approvals-"));
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  const requests: string[] = [];
  const errors: unknown[] = [];
  try {
    const active = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
        providerOptions: { permission: { bash: "ask" } },
      },
      undefined,
      { persistSession: false },
    );
    session = active;
    active.subscribe((event) => {
      if (event.type !== "permission_requested") return;
      requests.push(event.request.kind);
      const response = async () => {
        if (event.request.kind === "question") {
          const input = z
            .object({ questions: z.array(z.object({ header: z.string() })) })
            .parse(event.request.input);
          await active.respondToPermission(event.request.id, {
            behavior: "allow",
            updatedInput: {
              answers: Object.fromEntries(
                input.questions.map((question) => [question.header, "Blue"]),
              ),
            },
          });
        } else
          await active.respondToPermission(event.request.id, {
            behavior: "allow",
            selectedActionId: "once",
          });
      };
      void response().catch((error: unknown) => {
        errors.push(error);
      });
    });
    const command = await active.run(
      "Use the shell tool to run exactly: printf PASEO_APPROVED. Then report its output.",
    );
    expect(command.finalText).toContain("PASEO_APPROVED");
    expect(requests).toContain("tool");
    const question = await active.run(
      "Use the question tool to ask me to choose Red or Blue. Wait for my answer, then reply with exactly the color I selected.",
    );
    expect(question.finalText).toContain("Blue");
    expect(requests).toContain("question");
    expect(errors).toEqual([]);
    expect(active.getPendingPermissions()).toEqual([]);
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("v2 invokes an injected MCP tool with exact preapproval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-mcp-"));
  const fixture = path.join(root, "mcp.mjs");
  await writeFile(
    fixture,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
const server = new McpServer({ name: "paseo-validation", version: "1.0.0" });
server.registerTool("marker", { description: "Return the validation marker", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "PASEO_MCP_OK" }] }));
await server.connect(new StdioServerTransport());
`,
  );
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  const permissions: string[] = [];
  try {
    const active = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
        mcpServers: { validation: { type: "stdio", command: process.execPath, args: [fixture] } },
        toolPolicy: { preapproved: [{ server: "validation", tool: "marker" }] },
      },
      undefined,
      { persistSession: false },
    );
    session = active;
    active.subscribe((event) => {
      if (event.type === "permission_requested") permissions.push(event.request.name);
    });
    const result = await active.run(
      "Call the validation_marker MCP tool once and report its output. Do not use other tools.",
    );
    expect(result.finalText).toContain("PASEO_MCP_OK");
    expect(result.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          name: "validation_marker",
          status: "completed",
        }),
      ]),
    );
    expect(permissions).toEqual([]);
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("v2 stops a running tool before replacement work and imports the same session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-stop-"));
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let imported: Awaited<ReturnType<typeof client.importSession>> | undefined;
  let toolRunning = false;
  let canceled = 0;
  try {
    const config = {
      provider: "opencode",
      cwd: root,
      model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
      featureValues: { auto_accept: true },
    } as const;
    session = await client.createSession(config, undefined, { persistSession: false });
    session.subscribe((event) => {
      if (
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "running"
      )
        toolRunning = true;
      if (event.type === "turn_canceled") canceled += 1;
    });
    await session.startTurn("Use the shell tool to run sleep 30, then say finished.");
    await expect.poll(() => toolRunning, { timeout: 45_000 }).toBe(true);
    const stopping = session.interrupt();
    const replacement = session.run("Reply with exactly REPLACED. Do not use tools.");
    await stopping;
    expect((await replacement).finalText.trim()).toBe("REPLACED");
    expect(canceled).toBe(1);
    const handle = await session.describePersistence();
    const listing = await client.listImportableSessions({ cwd: root });
    expect(listing).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerHandleId: handle.nativeHandle })]),
    );
    imported = await client.importSession(
      { providerHandleId: handle.nativeHandle!, cwd: root },
      { config, storedConfig: config },
    );
    expect(imported.persistence.nativeHandle).toBe(handle.nativeHandle);
    expect(imported.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ type: "assistant_message", text: "REPLACED" }),
        }),
      ]),
    );
  } finally {
    await imported?.session.close();
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("v2 rewinds conversation and files and reports autonomous subagents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-rewind-"));
  await execCommand("git", ["init", root]);
  await writeFile(path.join(root, "marker.txt"), "before\n");
  await execCommand("git", ["add", "marker.txt"], { cwd: root });
  await execCommand(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "baseline",
    ],
    { cwd: root },
  );
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let childCompleted = false;
  let childText = "";
  try {
    session = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
        featureValues: { auto_accept: true },
      },
      undefined,
      { persistSession: false },
    );
    await session.setMode!("plan");
    expect(await session.getCurrentMode!()).toBe("plan");
    await session.setMode!("build");
    const edited = await session.run(
      "Edit marker.txt so its entire content is after followed by a newline. Use the file editing tools; do not use shell commands. Then say done.",
    );
    expect((await readFile(path.join(root, "marker.txt"), "utf8")).trim()).toBe("after");
    const user = edited.timeline.find((item) => item.type === "user_message");
    if (!user || user.type !== "user_message" || !user.messageId)
      throw new Error("Missing native user message ID");
    await session.revertBoth!({ messageId: user.messageId });
    expect(await readFile(path.join(root, "marker.txt"), "utf8")).toBe("before\n");
    const history = [];
    for await (const event of session.streamHistory!()) history.push(event);
    expect(history).toEqual([]);
    session.subscribe((event) => {
      if (event.type !== "provider_subagent") return;
      if (event.event.type === "upsert" && event.event.status === "completed")
        childCompleted = true;
      if (event.event.type === "timeline" && event.event.item.type === "assistant_message")
        childText += event.event.item.text;
    });
    const delegated = await session.run(
      "Use the subagent tool to delegate to a general subagent. Tell it to reply with exactly CHILD_OK without using tools. Wait for it, then report CHILD_OK.",
    );
    expect(delegated.finalText).toContain("CHILD_OK");
    await expect.poll(() => childCompleted, { timeout: 10_000 }).toBe(true);
    expect(childText).toContain("CHILD_OK");
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("v2 executes commands and retains context after compaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-commands-"));
  const commandDir = path.join(root, ".opencode", "command");
  await mkdir(commandDir, { recursive: true });
  await writeFile(
    path.join(commandDir, "validation.md"),
    "---\ndescription: Validation command\n---\nReply with exactly COMMAND_OK. Do not use tools.\n",
  );
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  try {
    session = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
      },
      undefined,
      { persistSession: false },
    );
    await session.setThinkingOption!("low");
    expect((await session.getRuntimeInfo!()).thinkingOptionId).toBe("low");
    const commands = await session.listCommands!();
    expect(commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "validation", kind: "command" })]),
    );
    expect((await session.run("/validation")).finalText).toContain("COMMAND_OK");
    await session.run("Remember the secret word ORANGE. Reply OK without tools.");
    await session.run("/compact");
    expect(
      (await session.run("What secret word did I ask you to remember? Reply with only that word."))
        .finalText,
    ).toContain("ORANGE");
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("v2 executes discovered skills and accepts image attachments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-attachments-"));
  const skillDir = path.join(root, ".opencode", "skills", "validation");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: validation\ndescription: Validation skill\n---\nReply with exactly SKILL_OK when asked to use this skill. Do not use tools.\n",
  );
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger() });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  try {
    session = await client.createSession(
      {
        provider: "opencode",
        cwd: root,
        model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
      },
      undefined,
      { persistSession: false },
    );
    const skill = (await session.listCommands!()).find(
      (item) => item.kind === "skill" && item.name.includes("validation"),
    );
    expect(skill).toBeDefined();
    expect((await session.run(`/${skill!.name}`)).finalText).toContain("SKILL_OK");
    const result = await session.run([
      {
        type: "text",
        text: "An image is attached. Reply exactly IMAGE_OK if you received it. Do not use tools.",
      },
      {
        type: "image",
        mimeType: "image/png",
        data: (
          await readFile(new URL("../../../../../desktop/assets/32x32.png", import.meta.url))
        ).toString("base64"),
      },
    ]);
    expect(result.finalText).toContain("IMAGE_OK");
  } finally {
    await session?.interrupt();
    await session?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
