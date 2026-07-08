import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { AGENT_WAIT_TIMEOUT_MS } from "./mcp-shared.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentClient, AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

function str(val: unknown): string {
  return z.string().parse(val);
}

function recordArr(val: unknown): StructuredContent[] {
  return z.array(z.record(z.string(), z.unknown())).parse(val);
}

function expectAgentFeatureValue(snapshot: StructuredContent, featureId: string, value: unknown) {
  expect(recordArr(snapshot.features)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: featureId,
        value,
      }),
    ]),
  );
}

function strArrOptional(val: unknown): string[] | undefined {
  return z.array(z.string()).optional().parse(val);
}

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildExpectedAgentMcpUrl(params: { host: string; port: number; agentId: string }): string {
  const baseUrl = new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(params.host)}:${params.port}`,
  );
  baseUrl.searchParams.set("callerAgentId", params.agentId);
  return baseUrl.toString();
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) {
      return content.structuredContent;
    }
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

async function callToolStructured(
  client: McpClient,
  name: string,
  args?: StructuredContent,
): Promise<StructuredContent> {
  const result = await client.callTool({ name, args: args ?? {} });
  const payload = getStructuredContent(result);
  if (!payload) {
    throw new Error(`${name} returned no structured payload`);
  }
  return payload;
}

async function expectToolError(
  client: McpClient,
  name: string,
  args: StructuredContent,
  pattern: RegExp,
): Promise<void> {
  const result = await client.callTool({ name, args });
  expect(result.isError).toBe(true);
  const contentItem = result.content?.[0];
  const contentText: string | undefined =
    contentItem != null && typeof contentItem === "object"
      ? Reflect.get(contentItem, "text")
      : undefined;
  expect(contentText ?? "").toMatch(pattern);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(options: {
  timeoutMs: number;
  intervalMs?: number;
  check: () => Promise<T | null> | T | null;
  label: string;
}): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const result = await options.check();
    if (result !== null) {
      return result;
    }
    await sleep(options.intervalMs ?? 50);
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
}

let tempRoot: string;
let daemonHandle: TestPaseoDaemon;
let topLevelClient: McpClient;
let agentScopedClient: McpClient;
let parentAgentId: string;
let parentAgentCwd: string;
let worktreeRepoCwd: string;
let launchConfigsByProvider: Record<AgentProvider, AgentSessionConfig[]>;

function createRecordingAgentClients(): Record<AgentProvider, AgentClient> {
  const baseClients = createTestAgentClients();
  launchConfigsByProvider = {};
  const wrappedClients: Record<AgentProvider, AgentClient> = {};

  for (const [provider, client] of Object.entries(baseClients)) {
    const launchConfigs: AgentSessionConfig[] = [];
    launchConfigsByProvider[provider] = launchConfigs;
    const wrappedClient: AgentClient = {
      provider: client.provider,
      capabilities: client.capabilities,
      createSession: async (config, launchContext, options) => {
        launchConfigs.push(config);
        return await client.createSession(config, launchContext, options);
      },
      resumeSession: async (handle, overrides, launchContext) =>
        await client.resumeSession(handle, overrides, launchContext),
      fetchCatalog: async (options) => await client.fetchCatalog(options),
      isAvailable: async () => await client.isAvailable(),
    };
    if (client.resolveCreateConfig) {
      wrappedClient.resolveCreateConfig = (input) => client.resolveCreateConfig!(input);
    }
    if (client.isCreateConfigUnattended) {
      wrappedClient.isCreateConfigUnattended = (input) => client.isCreateConfigUnattended!(input);
    }
    if (client.listCommands) {
      wrappedClient.listCommands = async (config) => await client.listCommands!(config);
    }
    if (client.listFeatures) {
      wrappedClient.listFeatures = async (config) => await client.listFeatures!(config);
    }
    if (client.listImportableSessions) {
      wrappedClient.listImportableSessions = async (options) =>
        await client.listImportableSessions!(options);
    }
    if (client.importSession) {
      wrappedClient.importSession = async (input, context) =>
        await client.importSession!(input, context);
    }
    wrappedClients[provider] = wrappedClient;
  }

  return wrappedClients;
}

async function makeCwd(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tempRoot, `${prefix}-`));
}

async function createTopLevelAgent(args?: Partial<StructuredContent>): Promise<string> {
  const cwd = typeof args?.cwd === "string" ? args.cwd : await makeCwd("agent-cwd");
  const { cwd: _cwd, ...rest } = args ?? {};
  const payload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: cwd } },
    title: "Parity agent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    background: true,
    ...rest,
  });
  return str(payload.agentId);
}

async function createChildAgent(args?: Partial<StructuredContent>): Promise<string> {
  const payload = await callToolStructured(agentScopedClient, "create_agent", {
    relationship: { kind: "subagent" },
    workspace: { kind: "current" },
    title: "Parity child",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    notifyOnFinish: false,
    ...args,
  });
  return str(payload.agentId);
}

async function archiveAgentIfPresent(agentId: string | null | undefined): Promise<void> {
  if (!agentId) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "archive_agent", args: { agentId } });
  } catch {
    // ignore cleanup errors
  }
}

async function deleteScheduleIfPresent(id: string | null | undefined): Promise<void> {
  if (!id) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "delete_schedule", args: { id } });
  } catch {
    // ignore cleanup errors
  }
}

async function killTerminalIfPresent(terminalId: string | null | undefined): Promise<void> {
  if (!terminalId) {
    return;
  }
  try {
    await agentScopedClient.callTool({ name: "kill_terminal", args: { terminalId } });
  } catch {
    // ignore cleanup errors
  }
}

async function archiveWorktreeIfPresent(params: {
  cwd: string;
  worktreePath?: string | null;
  worktreeSlug?: string | null;
}): Promise<void> {
  if (!params.worktreePath && !params.worktreeSlug) {
    return;
  }
  try {
    await topLevelClient.callTool({
      name: "archive_worktree",
      args: {
        cwd: params.cwd,
        ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
        ...(params.worktreeSlug ? { worktreeSlug: params.worktreeSlug } : {}),
      },
    });
  } catch {
    // ignore cleanup errors
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-parity-e2e-"));
  parentAgentCwd = await makeCwd("parent-agent-cwd");
  worktreeRepoCwd = await makeCwd("worktree-repo");

  daemonHandle = await createTestPaseoDaemon({ agentClients: createRecordingAgentClients() });
  topLevelClient = await createMcpClient(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`);

  const parentPayload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: parentAgentCwd } },
    title: "MCP parity parent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    background: true,
  });
  parentAgentId = str(parentPayload.agentId);

  agentScopedClient = await createMcpClient(
    `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${parentAgentId}`,
  );

  execSync("git init -b main", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.email 'test@example.com'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.name 'Test User'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  await writeFile(path.join(worktreeRepoCwd, "README.md"), "# repo\n", "utf8");
  execSync("git add README.md", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'init'", {
    cwd: worktreeRepoCwd,
    stdio: "pipe",
  });
}, 30_000);

afterAll(async () => {
  await archiveAgentIfPresent(parentAgentId);
  await agentScopedClient?.close();
  await topLevelClient?.close();
  await daemonHandle?.close();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("Suite A: Core Fixes", () => {
  test("AGENT_WAIT_TIMEOUT_MS is 30000", () => {
    expect(AGENT_WAIT_TIMEOUT_MS).toBe(30_000);
  });

  test("create_agent with callerAgentId sets the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent();
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({
        [PARENT_AGENT_ID_LABEL]: parentAgentId,
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent with detached relationship omits the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({ relationship: { kind: "detached" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels?.[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agentManager.createAgent injects paseo MCP using the daemon listen target", async () => {
    let agentId: string | null = null;
    try {
      const listenTarget = daemonHandle.daemon.getListenTarget();
      expect(listenTarget?.type).toBe("tcp");
      const cwd = await makeCwd("manager-direct-agent-cwd");

      const snapshot = await daemonHandle.daemon.agentManager.createAgent(
        {
          provider: "claude",
          cwd,
          title: "Manager direct parity agent",
          modeId: "bypassPermissions",
        },
        undefined,
        { workspaceId: undefined },
      );
      agentId = snapshot.id;

      const expectedUrl = buildExpectedAgentMcpUrl({
        host: listenTarget!.host,
        port: listenTarget!.port,
        agentId,
      });

      const launchConfig = launchConfigsByProvider.claude
        ?.toReversed()
        .find((config) => config.cwd === cwd);
      expect(launchConfig?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: expectedUrl,
        },
      });
      expect(snapshot.config.mcpServers?.paseo).toBeUndefined();

      const liveAgent = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(liveAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider/model syntax", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ provider: "claude/claude-test-model" });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.config.model).toBe("claude-test-model");
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: true } } });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agent-scoped create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({
        provider: "claude/claude-test-model",
        settings: { features: { test_feature: true } },
      });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: false } } });
      const updated = await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        settings: { features: { test_feature: true } },
      });
      expect(updated.success).toBe(true);
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("inspect_provider returns draft provider features over MCP", async () => {
    const payload = await callToolStructured(topLevelClient, "inspect_provider", {
      provider: "claude",
      cwd: parentAgentCwd,
      settings: {
        model: "claude-test-model",
        features: { test_feature: true },
      },
    });

    expect(payload.provider).toBe("claude");
    expect(payload.selectedModel).toBe("claude-test-model");
    expect(recordArr(payload.features)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "toggle",
          id: "test_feature",
          value: true,
        }),
      ]),
    );
  });

  test("create_agent accepts labels param", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ labels: { team: "infra" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({ team: "infra" });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("archive_agent archives an agent", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      const archivedAgentId = agentId;
      await callToolStructured(topLevelClient, "archive_agent", { agentId });
      agentId = null;

      const agents = daemonHandle.daemon.agentManager.listAgents();
      expect(agents.some((agent) => agent.id === archivedAgentId)).toBe(false);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates name and labels", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        name: "Renamed parity agent",
        labels: { team: "infra", surface: "mcp" },
      });

      const stored = await daemonHandle.daemon.agentStorage.get(agentId);
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(stored?.title).toBe("Renamed parity agent");
      expect(snapshot?.labels).toMatchObject({
        team: "infra",
        surface: "mcp",
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });
});

describe("Suite B: Terminal Tools", () => {
  test("create_terminal and list_terminals", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity terminal",
      });
      terminalId = str(created.id);

      const listed = await callToolStructured(agentScopedClient, "list_terminals");
      const terminals = recordArr(listed.terminals);
      expect(terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: terminalId,
            name: "Parity terminal",
            cwd: parentAgentCwd,
          }),
        ]),
      );
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("send_terminal_keys and capture_terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity capture terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "send_terminal_keys", {
        terminalId,
        keys: "echo hello\r",
        literal: true,
      });
      await sleep(500);

      const captured = await waitFor({
        timeoutMs: 10_000,
        intervalMs: 100,
        label: "terminal output to contain hello",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "capture_terminal", {
            terminalId,
            scrollback: true,
          });
          const lines = strArrOptional(payload.lines) ?? [];
          return lines.some((line) => line.includes("hello")) ? payload : null;
        },
      });

      expect(captured.lines).toEqual(expect.arrayContaining([expect.stringContaining("hello")]));
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal removes terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity kill terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "kill_terminal", { terminalId });
      terminalId = null;

      const listed = await waitFor({
        timeoutMs: 5_000,
        intervalMs: 100,
        label: "terminal removal",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "list_terminals");
          const terminals = recordArr(payload.terminals);
          return terminals.some((terminal) => terminal.id === created.id) ? null : payload;
        },
      });
      const terminals = recordArr(listed.terminals);
      expect(terminals.some((terminal) => terminal.id === created.id)).toBe(false);
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal with invalid id throws", async () => {
    await expectToolError(
      agentScopedClient,
      "kill_terminal",
      { terminalId: "missing-terminal-id" },
      /not found/i,
    );
  });
});

describe("Suite C: Schedule Tools", () => {
  test("create_schedule and list_schedules", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity schedule list",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: scheduleId,
            name: "Parity schedule list",
          }),
        ]),
      );
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule accepts provider/model syntax", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity provider schedule",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("inspect_schedule returns details", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity inspect schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const inspected = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(inspected).toMatchObject({
        id: scheduleId,
        name: "Parity inspect schedule",
        prompt: "say hello",
        status: "active",
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("pause and resume schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity pause schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "pause_schedule", { id: scheduleId });
      const paused = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(paused.status).toBe("paused");

      await callToolStructured(topLevelClient, "resume_schedule", { id: scheduleId });
      const resumed = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(resumed.status).toBe("active");
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("delete_schedule removes schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity delete schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "delete_schedule", { id: scheduleId });
      scheduleId = null;

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules.some((schedule) => schedule.id === created.id)).toBe(false);
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat targets the scoped agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_heartbeat", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity heartbeat",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "agent",
        agentId: parentAgentId,
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule on agent MCP accepts provider/model override for new-agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat without callerAgentId throws", async () => {
    await expectToolError(
      topLevelClient,
      "create_heartbeat",
      {
        prompt: "say hello",
        cron: "*/5 * * * *",
      },
      /requires an agent-scoped session/i,
    );
  });
});

describe("Suite D: Provider Tools", () => {
  test("list_providers returns providers", async () => {
    const payload = await callToolStructured(topLevelClient, "list_providers");
    const providers = recordArr(payload.providers);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        modes: expect.any(Array),
      }),
    );
  });

  test("list_models returns models for provider", async () => {
    const payload = await callToolStructured(topLevelClient, "list_models", {
      provider: "claude",
    });
    expect(payload.provider).toBe("claude");
    expect(Array.isArray(payload.models)).toBe(true);
  });
});

describe("Suite E: Worktree Tools", () => {
  test("list_worktrees on empty repo", async () => {
    const payload = await callToolStructured(topLevelClient, "list_worktrees", {
      cwd: worktreeRepoCwd,
    });
    expect(payload.worktrees).toEqual([]);
  });

  test("create_worktree and list_worktrees", async () => {
    let worktreePath: string | null = null;
    const branchName = `parity-create-${Date.now()}`;
    try {
      const created = await callToolStructured(topLevelClient, "create_worktree", {
        cwd: worktreeRepoCwd,
        target: {
          kind: "branch-off",
          worktreeSlug: branchName,
          baseBranch: "main",
        },
      });
      worktreePath = str(created.worktreePath);

      const listed = await callToolStructured(topLevelClient, "list_worktrees", {
        cwd: worktreeRepoCwd,
      });
      const worktrees = recordArr(listed.worktrees);
      expect(worktrees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: worktreePath,
            branchName,
          }),
        ]),
      );
    } finally {
      await archiveWorktreeIfPresent({ cwd: worktreeRepoCwd, worktreePath });
    }
  });

  test("archive_worktree removes worktree", async () => {
    let worktreePath: string | null = null;
    const branchName = `parity-archive-${Date.now()}`;
    try {
      const created = await callToolStructured(topLevelClient, "create_worktree", {
        cwd: worktreeRepoCwd,
        target: {
          kind: "branch-off",
          worktreeSlug: branchName,
          baseBranch: "main",
        },
      });
      worktreePath = str(created.worktreePath);

      await callToolStructured(topLevelClient, "archive_worktree", {
        cwd: worktreeRepoCwd,
        worktreePath,
      });
      worktreePath = null;

      const listed = await callToolStructured(topLevelClient, "list_worktrees", {
        cwd: worktreeRepoCwd,
      });
      const worktrees = recordArr(listed.worktrees);
      expect(worktrees.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
    } finally {
      await archiveWorktreeIfPresent({ cwd: worktreeRepoCwd, worktreePath });
    }
  });

  test("archive_worktree succeeds when caller cwd is inside the archived worktree", async () => {
    let worktreePath: string | null = null;
    let worktreeAgentId: string | null = null;
    let worktreeScopedClient: McpClient | null = null;
    const branchName = `parity-archive-self-cwd-${Date.now()}`;

    try {
      const created = await callToolStructured(topLevelClient, "create_worktree", {
        cwd: worktreeRepoCwd,
        target: {
          kind: "branch-off",
          worktreeSlug: branchName,
          baseBranch: "main",
        },
      });
      worktreePath = str(created.worktreePath);
      worktreeAgentId = await createTopLevelAgent({
        cwd: worktreePath,
        title: "Worktree scoped parity agent",
      });
      worktreeScopedClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${encodeURIComponent(
          worktreeAgentId,
        )}`,
      );

      const archived = await callToolStructured(worktreeScopedClient, "archive_worktree", {
        worktreePath,
      });
      expect(archived).toEqual({ success: true });
      worktreePath = null;
      worktreeAgentId = null;

      const listed = await callToolStructured(topLevelClient, "list_worktrees", {
        cwd: worktreeRepoCwd,
      });
      const worktrees = recordArr(listed.worktrees);
      expect(worktrees.map((worktree) => worktree.path)).not.toContain(created.worktreePath);
    } finally {
      await worktreeScopedClient?.close();
      await archiveAgentIfPresent(worktreeAgentId);
      await archiveWorktreeIfPresent({ cwd: worktreeRepoCwd, worktreePath });
    }
  });
});
