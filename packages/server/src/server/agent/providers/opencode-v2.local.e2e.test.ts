import { V2Runtime } from "./opencode/v2/runtime.js";
import type { V2Api } from "./opencode/v2/api.js";
import { execCommand } from "../../../utils/spawn.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  autoRespondToPermissions,
  collectPermissions,
  collectProviderSubagents,
  collectRunningToolCalls,
  collectStreamedAssistantText,
  drainPersistedAssistantText,
  drainPersistedTimeline,
  findSkillCommand,
  requireNativeUserMessageId,
} from "./opencode/test-utils/v2-local-e2e-helpers.js";

test("v2 shares a helper across agent identities and keeps the remaining session alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-shared-"));
  const runtime = new V2Runtime({ logger: createTestLogger() });
  const clients = new Set<V2Api>();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: {
      acquire: async (input) => {
        const connection = await runtime.acquire(input);
        clients.add(connection.client);
        return connection;
      },
      shutdown: () => runtime.shutdown(),
    },
  });
  const sessions: Awaited<ReturnType<typeof client.createSession>>[] = [];
  try {
    for (const agentId of ["first", "second"]) {
      sessions.push(
        await client.createSession(
          { provider: "opencode", cwd: root },
          { agentId, env: { PASEO_AGENT_ID: agentId, PASEO_AGENT_CWD: root } },
          { persistSession: false },
        ),
      );
    }
    expect(clients.size).toBe(1);
    expect(sessions[0].id).not.toBe(sessions[1].id);
    await sessions[0].close();
    expect((await sessions[1].getRuntimeInfo()).sessionId).toBe(sessions[1].id);
  } finally {
    for (const session of sessions) await session.close();
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
    expect(await drainPersistedTimeline(session)).toEqual(
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

test("v2 preserves final text without duplicating streamed content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-stream-"));
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
    const chunks = collectStreamedAssistantText(session);
    const result = await session.run("Count from one to five, one word per line, with no tools.");
    // Delta granularity is the provider's: some coalesce a whole reply into a
    // single `session.text.delta`. Assert delivery happened and, critically,
    // that the post-turn snapshot did not replay delivered content.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const persistedText = await drainPersistedAssistantText(session);
    expect(chunks.join("")).toBe(persistedText.join(""));
    expect(result.finalText).toBe(persistedText.join(""));
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
    const permissions = autoRespondToPermissions(active);
    const command = await active.run(
      "Use the shell tool to run exactly: printf PASEO_APPROVED. Then report its output.",
    );
    expect(command.finalText).toContain("PASEO_APPROVED");
    expect(permissions.kinds).toContain("tool");
    const question = await active.run(
      "Use the question tool to ask me to choose Red or Blue. Wait for my answer, then reply with exactly the color I selected.",
    );
    expect(question.finalText).toContain("Blue");
    expect(permissions.kinds).toContain("question");
    expect(permissions.errors).toEqual([]);
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
    const permissions = collectPermissions(active);
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
  try {
    const config = {
      provider: "opencode",
      cwd: root,
      model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-6-astra",
      featureValues: { auto_accept: true },
    } as const;
    session = await client.createSession(config, undefined, { persistSession: false });
    const tools = collectRunningToolCalls(session);
    await session.startTurn("Use the shell tool to run sleep 30, then say finished.");
    await expect.poll(tools.hasRunningTool, { timeout: 45_000 }).toBe(true);
    const stopping = session.interrupt();
    const replacement = session.run("Reply with exactly REPLACED. Do not use tools.");
    await stopping;
    expect((await replacement).finalText.trim()).toBe("REPLACED");
    expect(tools.canceledTurns()).toBe(1);
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
    const userMessageId = requireNativeUserMessageId(edited.timeline);
    await session.revertBoth!({ messageId: userMessageId });
    expect(await readFile(path.join(root, "marker.txt"), "utf8")).toBe("before\n");
    expect(await drainPersistedAssistantText(session)).toEqual([]);
    const subagents = collectProviderSubagents(session);
    const delegated = await session.run(
      "Use the subagent tool to delegate to a general subagent. Tell it to reply with exactly CHILD_OK without using tools. Wait for it, then report CHILD_OK.",
    );
    expect(delegated.finalText).toContain("CHILD_OK");
    await expect.poll(subagents.hasCompletedChild, { timeout: 10_000 }).toBe(true);
    expect(subagents.childText()).toContain("CHILD_OK");
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
    const skill = findSkillCommand(await session.listCommands!(), "validation");
    expect((await session.run(`/${skill.name}`)).finalText).toContain("SKILL_OK");
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
