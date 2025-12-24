import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentClient,
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function tmpCwd(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codex-mcp-e2e-"));
}

function useTempCodexSessionDir(): () => void {
  const prevSessionDir = process.env.CODEX_SESSION_DIR;
  const prevHome = process.env.CODEX_HOME;
  return () => {
    if (prevSessionDir === undefined) {
      delete process.env.CODEX_SESSION_DIR;
    } else {
      process.env.CODEX_SESSION_DIR = prevSessionDir;
    }
    if (prevHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevHome;
    }
  };
}

function writeTestMcpServerScript(cwd: string): string {
  const scriptPath = path.join(cwd, "mcp-stdio-server.mjs");
  const script = [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    "import { z } from 'zod';",
    "",
    "const server = new McpServer({ name: 'test', version: '0.0.1' });",
    "server.registerTool(",
    "  'echo',",
    "  {",
    "    title: 'Echo tool',",
    "    description: 'Returns the input text',",
    "    inputSchema: { text: z.string() },",
    "    outputSchema: { text: z.string() }",
    "  },",
    "  async ({ text }) => ({",
    "    content: [],",
    "    structuredContent: { text }",
    "  })",
    ");",
    "const transport = new StdioServerTransport();",
    "await server.connect(transport);",
    "",
  ].join("\n");
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

async function loadCodexMcpAgentClient(): Promise<{
  new (): AgentClient;
}> {
  try {
    return (await import("./codex-mcp-agent.js")) as {
      CodexMcpAgentClient: new () => AgentClient;
    };
  } catch (error) {
    throw new Error(
      `Failed to import codex-mcp-agent: ${(error as Error).message}`
    );
  }
}

function providerFromEvent(event: AgentStreamEvent): string | undefined {
  return (event as { provider?: string }).provider;
}

function extractExitCode(output: unknown): number | undefined {
  if (!output || typeof output !== "object") {
    return undefined;
  }
  const outputRecord = output as Record<string, unknown>;
  const direct = outputRecord.exitCode ?? outputRecord.exit_code;
  if (typeof direct === "number") {
    return direct;
  }
  const metadata = outputRecord.metadata;
  if (metadata && typeof metadata === "object") {
    const metadataRecord = metadata as Record<string, unknown>;
    const metaCode = metadataRecord.exit_code ?? metadataRecord.exitCode;
    if (typeof metaCode === "number") {
      return metaCode;
    }
  }
  return undefined;
}

function commandTextFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command === "string" && command.length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((value): value is string => typeof value === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  return null;
}

function isSleepCommandToolCall(item: ToolCallItem): boolean {
  const display = typeof item.displayName === "string" ? item.displayName.toLowerCase() : "";
  if (display.includes("sleep 60")) {
    return true;
  }
  const inputText = commandTextFromInput(item.input)?.toLowerCase() ?? "";
  return inputText.includes("sleep 60");
}

describe("CodexMcpAgentClient (MCP integration)", () => {
  test(
    "responds with text",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;

      try {
        session = await client.createSession(config);
        const response = await session.run("Reply READY and stop.");
        expect(response.finalText.toLowerCase()).toContain("ready");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "maps MCP stream events into timeline items with stable call ids",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      const toolCalls: ToolCallItem[] = [];
      const rawCommandEvents: unknown[] = [];
      let sawAssistant = false;
      let sawReasoning = false;

      try {
        session = await client.createSession(config);

        const prompt = [
          "1. Run the command `pwd` using your shell tool and wait for it to finish.",
          "2. Use apply_patch (not the shell) to create a file named mcp-event.log containing the single line 'ok'.",
          "3. After the patch succeeds, reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          const provider = providerFromEvent(event);
          if (event.type === "timeline" && provider === "codex-mcp") {
            if (event.item.type === "assistant_message") {
              sawAssistant = true;
            }
            if (event.item.type === "reasoning") {
              sawReasoning = true;
            }
            if (event.item.type === "tool_call" && event.item.server !== "permission") {
              toolCalls.push(event.item);
            }
          }

          const rawEvent = (event as { type?: string; raw?: unknown }).type === "provider_event"
            ? (event as { raw?: unknown }).raw
            : null;
          if (rawEvent && typeof rawEvent === "object") {
            const itemType = (rawEvent as { item?: { type?: string } }).item?.type;
            if (itemType === "command_execution") {
              rawCommandEvents.push(rawEvent);
            }
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawAssistant).toBe(true);
        expect(sawReasoning).toBe(true);
        expect(toolCalls.length).toBeGreaterThan(0);

        const uniqueIds = new Set(
          toolCalls.map((item) => (typeof item.callId === "string" ? item.callId : ""))
        );
        expect(uniqueIds.size).toBeGreaterThan(0);
        for (const toolCall of toolCalls) {
          expect(typeof toolCall.callId).toBe("string");
          expect((toolCall.callId ?? "").trim().length).toBeGreaterThan(0);
        }

        const commandToolCall = toolCalls.find(
          (item) => item.server === "command"
        );
        expect(commandToolCall).toBeTruthy();

        const exitCode = extractExitCode(commandToolCall?.output);
        if (exitCode === undefined) {
          throw new Error(
            `Missing exit code in command output. Raw events:\n${JSON.stringify(
              rawCommandEvents[0] ?? null,
              null,
              2
            )}`
          );
        }
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "maps thread/item events for file changes, MCP tools, web search, and todo lists",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const mcpServerScript = writeTestMcpServerScript(cwd);
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        extra: {
          codex: {
            mcp_servers: {
              test: {
                command: process.execPath,
                args: [mcpServerScript],
              },
            },
          },
        },
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      const timelineItems: AgentTimelineItem[] = [];
      const rawItemTypes = new Set<string>();
      let sawThreadEvent = false;
      let sawItemEvent = false;

      try {
        session = await client.createSession(config);

        const prompt = [
          "Use the web_search tool to search for \"OpenAI\".",
          "Use the todo_list tool to create a list with exactly two items: alpha, beta.",
          "Call the MCP tool test.echo with input {\"text\":\"hello\"}.",
          "Use apply_patch to create a file named mcp-thread.log containing the single line 'ok'.",
          "After all tools finish, reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          if (event.type === "provider_event" && providerFromEvent(event) === "codex-mcp") {
            const raw = event.raw as { type?: string; item?: { type?: string } } | undefined;
            if (raw?.type && typeof raw.type === "string") {
              if (raw.type.startsWith("thread.") || raw.type.startsWith("turn.")) {
                sawThreadEvent = true;
              }
              if (raw.type.startsWith("item.")) {
                sawItemEvent = true;
                if (raw.item?.type) {
                  rawItemTypes.add(raw.item.type);
                }
              }
            }
          }

          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            timelineItems.push(event.item);
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawThreadEvent).toBe(true);
        expect(sawItemEvent).toBe(true);
        expect(rawItemTypes.has("file_change")).toBe(true);
        expect(rawItemTypes.has("mcp_tool_call")).toBe(true);
        expect(rawItemTypes.has("web_search")).toBe(true);
        expect(rawItemTypes.has("todo_list")).toBe(true);

        expect(
          timelineItems.some(
            (item) => item.type === "tool_call" && item.server === "file_change"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "test" &&
              item.tool === "echo"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "web_search" &&
              item.tool === "web_search"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "todo" &&
              Array.isArray(item.items) &&
              item.items.length >= 2
          )
        ).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "emits an error timeline item for failed MCP turns",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let sawErrorTimeline = false;
      const errorEvents: AgentStreamEvent[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Run the command `bash -lc \"exit 7\"` using your shell tool.",
          "After the command finishes (even if it fails), reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          const provider = providerFromEvent(event);
          if (event.type === "timeline" && provider === "codex-mcp") {
            if (event.item.type === "error") {
              sawErrorTimeline = true;
            }
          }
          if (event.type === "turn_failed") {
            errorEvents.push(event);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(sawErrorTimeline).toBe(true);
        expect(errorEvents.length).toBeGreaterThan(0);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "persists session metadata and resumes with history",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let resumed: AgentSession | null = null;
      const token = `ALPHA-${randomUUID()}`;

      try {
        session = await client.createSession(config);

        const first = await session.run(
          `Remember the word ${token} and reply with ACK.`
        );
        expect(first.finalText.toLowerCase()).toContain("ack");

        const handle = session.describePersistence();
        expect(handle?.sessionId).toBeTruthy();
        if (!handle) {
          throw new Error("Missing persistence handle for Codex MCP session");
        }

        const conversationId =
          handle.metadata && typeof handle.metadata === "object"
            ? (handle.metadata as Record<string, unknown>).conversationId
            : undefined;
        expect(typeof conversationId).toBe("string");
        expect((conversationId as string).length).toBeGreaterThan(0);

        await session.close();
        session = null;

        resumed = await client.resumeSession(handle);
        const history: AgentStreamEvent[] = [];
        for await (const event of resumed.streamHistory()) {
          history.push(event);
        }

        expect(
          history.some(
            (event) =>
              event.type === "timeline" &&
              providerFromEvent(event) === "codex-mcp" &&
              (event.item.type === "assistant_message" ||
                event.item.type === "user_message")
          )
        ).toBe(true);

        const response = await resumed.run(
          `Respond with the exact token ${token} and stop.`
        );
        expect(response.finalText).toContain(token);

        const resumedHandle = resumed.describePersistence();
        const resumedConversationId =
          resumedHandle?.metadata && typeof resumedHandle.metadata === "object"
            ? (resumedHandle.metadata as Record<string, unknown>).conversationId
            : undefined;
        expect(resumedHandle?.sessionId).toBe(handle.sessionId);
        expect(resumedConversationId).toBe(conversationId);
      } finally {
        await session?.close();
        await resumed?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "reports runtime info with provider, session, model, and mode",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        model: "gpt-5.1-codex",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;

      try {
        session = await client.createSession(config);
        const result = await session.run("Reply READY and stop.");
        expect(result.finalText.toLowerCase()).toContain("ready");

        const info = await session.getRuntimeInfo();
        expect(info.provider).toBe("codex-mcp");
        expect(typeof info.sessionId).toBe("string");
        expect((info.sessionId ?? "").length).toBeGreaterThan(0);
        expect(info.modeId).toBe("full-access");
        expect(typeof info.model).toBe("string");
        expect((info.model ?? "").length).toBeGreaterThan(0);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "requests permission and resolves approval when allowed",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        approvalPolicy: "on-request",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Request approval to run the command `pwd`.",
          "After approval, run it and reply DONE.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            expect(session.getPendingPermissions().length).toBeGreaterThan(0);
            await session.respondToPermission(captured.id, { behavior: "allow" });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "allow"
          ) {
            sawPermissionResolved = true;
          }
          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            timelineItems.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(captured).not.toBeNull();
        expect(sawPermissionResolved).toBe(true);
        expect(session.getPendingPermissions()).toHaveLength(0);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "permission" &&
              item.status === "granted"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) => item.type === "tool_call" && item.server === "command"
          )
        ).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "requires permission before commands in read-only (untrusted) mode",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "read-only",
        approvalPolicy: "untrusted",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Request approval to run the command `pwd`.",
          "After approval, run it and reply DONE.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            await session.respondToPermission(captured.id, { behavior: "allow" });
          }
          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            timelineItems.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        const permissionRequestIndex = timelineItems.findIndex(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "requested"
        );
        const commandIndex = timelineItems.findIndex(
          (item) => item.type === "tool_call" && item.server === "command"
        );

        expect(captured).not.toBeNull();
        expect(permissionRequestIndex).toBeGreaterThanOrEqual(0);
        expect(commandIndex).toBeGreaterThan(permissionRequestIndex);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "denies permission requests and reports resolution",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        approvalPolicy: "on-request",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionDenied = false;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Request approval to run the command `pwd`.",
          "If approval is denied, acknowledge and stop.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            await session.respondToPermission(captured.id, {
              behavior: "deny",
              message: "Not allowed.",
            });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "deny"
          ) {
            sawPermissionDenied = true;
          }
          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            timelineItems.push(event.item);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect(captured).not.toBeNull();
        expect(sawPermissionDenied).toBe(true);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "permission" &&
              item.status === "denied"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) => item.type === "tool_call" && item.server === "command"
          )
        ).toBe(false);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "aborts when permission responses request an interrupt",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        approvalPolicy: "on-request",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      let sawTurnFailed = false;
      let failureMessage: string | null = null;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "Request approval to run the command `pwd`.",
          "If approval is denied, stop immediately.",
        ].join(" ");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !captured) {
            captured = event.request;
            await session.respondToPermission(captured.id, {
              behavior: "deny",
              message: "Stop now.",
              interrupt: true,
            });
          }
          if (
            event.type === "permission_resolved" &&
            captured &&
            event.requestId === captured.id &&
            event.resolution.behavior === "deny" &&
            event.resolution.interrupt
          ) {
            sawPermissionResolved = true;
          }
          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            timelineItems.push(event.item);
          }
          if (event.type === "turn_failed") {
            sawTurnFailed = true;
            failureMessage = event.error;
            break;
          }
          if (event.type === "turn_completed") {
            break;
          }
        }

        expect(captured).not.toBeNull();
        expect(sawPermissionResolved).toBe(true);
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "permission" &&
              item.status === "denied"
          )
        ).toBe(true);
        expect(
          timelineItems.some(
            (item) => item.type === "tool_call" && item.server === "command"
          )
        ).toBe(false);
        expect(sawTurnFailed).toBe(true);
        expect(failureMessage ?? "").toMatch(/aborted|interrupted/i);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "interrupts a long-running command via abort",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "full-access",
        approvalPolicy: "on-request",
      } as AgentSessionConfig;

      let session: AgentSession | null = null;
      let runStartedAt: number | null = null;
      let durationMs = 0;
      let sawSleepCommand = false;
      let interruptIssued = false;

      try {
        session = await client.createSession(config);
        const prompt = [
          "Run the exact shell command `sleep 60` using your shell tool.",
          "Do not run any additional commands or send a response until that command finishes.",
        ].join(" ");

        runStartedAt = Date.now();
        const stream = session.stream(prompt);

        for await (const event of stream) {
          if (event.type === "permission_requested" && session) {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }

          if (
            event.type === "timeline" &&
            providerFromEvent(event) === "codex-mcp" &&
            event.item.type === "tool_call" &&
            event.item.server === "command" &&
            isSleepCommandToolCall(event.item)
          ) {
            sawSleepCommand = true;
            if (!interruptIssued) {
              interruptIssued = true;
              await session.interrupt();
            }
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        if (runStartedAt === null) {
          throw new Error("Codex MCP run never started");
        }
        durationMs = Date.now() - runStartedAt;
      } finally {
        if (durationMs === 0 && runStartedAt !== null) {
          durationMs = Date.now() - runStartedAt;
        }
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }

      expect(sawSleepCommand).toBe(true);
      expect(interruptIssued).toBe(true);
      expect(durationMs).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(60_000);
    },
    90_000
  );
});
