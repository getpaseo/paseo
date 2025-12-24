import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type {
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

function listProcesses(): string[] {
  try {
    const output = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function isProcessRunning(marker: string): boolean {
  return listProcesses().some((line) => line.includes(marker));
}

async function waitForProcessExit(marker: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(marker)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(marker);
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

async function loadCodexMcpAgentClient(): Promise<typeof import("./codex-mcp-agent.js")> {
  try {
    return await import("./codex-mcp-agent.js");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to import codex-mcp-agent: ${message}`
    );
  }
}

function providerFromEvent(event: AgentStreamEvent): string | undefined {
  return event.provider;
}

function resolveExclusiveValue<T>(
  label: string,
  entries: Array<{ key: string; value: T | undefined }>
): T | undefined {
  const present = entries.filter((entry) => entry.value !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length > 1) {
    const keys = present.map((entry) => entry.key).join(", ");
    throw new Error(`${label} provided multiple times (${keys})`);
  }
  return present[0].value;
}

const CommandInputSchema = z.object({
  command: z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]),
});

const ExitCodeOutputSchema = z
  .object({
    exitCode: z.number().optional(),
    exit_code: z.number().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

const ExitCodeMetadataSchema = z
  .object({
    exitCode: z.number().optional(),
    exit_code: z.number().optional(),
  })
  .passthrough();

function extractExitCode(output: unknown): number | undefined {
  const parsed = ExitCodeOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const direct = resolveExclusiveValue("exit code", [
    { key: "exitCode", value: parsed.data.exitCode },
    { key: "exit_code", value: parsed.data.exit_code },
  ]);
  if (direct !== undefined) {
    return direct;
  }
  const metaParsed = ExitCodeMetadataSchema.safeParse(parsed.data.metadata);
  if (!metaParsed.success) {
    return undefined;
  }
  return resolveExclusiveValue("exit code metadata", [
    { key: "exitCode", value: metaParsed.data.exitCode },
    { key: "exit_code", value: metaParsed.data.exit_code },
  ]);
}

function commandTextFromInput(input: unknown): string | null {
  const parsed = CommandInputSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  const command = parsed.data.command;
  return typeof command === "string" ? command : command.join(" ");
}

function commandOutputText(output: unknown): string | null {
  if (typeof output === "string") {
    return output;
  }
  const record = z
    .object({
      output: z.string().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .passthrough()
    .safeParse(output);
  if (!record.success) {
    return null;
  }
  const text = resolveExclusiveValue("command output text", [
    { key: "output", value: record.data.output },
    { key: "stdout", value: record.data.stdout },
    { key: "stderr", value: record.data.stderr },
  ]);
  return text ? text : null;
}

function stringifyUnknown(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

function isSleepCommandToolCall(item: ToolCallItem): boolean {
  const display = typeof item.displayName === "string" ? item.displayName.toLowerCase() : "";
  if (display.includes("sleep 60")) {
    return true;
  }
  const inputText = commandTextFromInput(item.input);
  if (!inputText) {
    return false;
  }
  return inputText.toLowerCase().includes("sleep 60");
}

const ProviderEventItemSchema = z
  .object({
    item: z
      .object({
        type: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function getProviderItemType(raw: unknown): string | undefined {
  const parsed = ProviderEventItemSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.item ? parsed.data.item.type : undefined;
}

const ProviderEventSchema = z
  .object({
    type: z.string(),
    item: z
      .object({
        type: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function parseProviderEvent(raw: unknown): { type: string; itemType?: string } | null {
  const parsed = ProviderEventSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return {
    type: parsed.data.type,
    itemType: parsed.data.item ? parsed.data.item.type : undefined,
  };
}

const MetadataConversationSchema = z
  .object({
    conversationId: z.string().optional(),
  })
  .passthrough();

function getConversationIdFromMetadata(metadata: unknown): string | undefined {
  const parsed = MetadataConversationSchema.safeParse(metadata);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.conversationId;
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
      } satisfies AgentSessionConfig;

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
      } satisfies AgentSessionConfig;

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

          const rawEvent = event.type === "provider_event" ? event.raw : null;
          if (rawEvent) {
            const itemType = getProviderItemType(rawEvent);
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
          toolCalls
            .map((item) => (typeof item.callId === "string" ? item.callId : undefined))
            .filter((callId): callId is string => typeof callId === "string")
        );
        expect(uniqueIds.size).toBeGreaterThan(0);
        for (const toolCall of toolCalls) {
          expect(typeof toolCall.callId).toBe("string");
          const callId = toolCall.callId;
          expect(typeof callId === "string" && callId.trim().length > 0).toBe(true);
        }

        const commandToolCall = toolCalls
          .slice()
          .reverse()
          .find(
            (item) =>
              item.server === "command" && item.status !== "running"
          );
        expect(commandToolCall).toBeTruthy();

        const exitCode = extractExitCode(commandToolCall?.output);
        if (exitCode === undefined) {
          const rawEvent = rawCommandEvents.length > 0 ? rawCommandEvents[0] : null;
          throw new Error(
            `Missing exit code in command output. Raw events:\n${JSON.stringify(
              rawEvent,
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
      } satisfies AgentSessionConfig;

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
            const parsed = parseProviderEvent(event.raw);
            if (parsed) {
              if (parsed.type.startsWith("thread.") || parsed.type.startsWith("turn.")) {
                sawThreadEvent = true;
              }
              if (parsed.type.startsWith("item.")) {
                sawItemEvent = true;
                if (parsed.itemType) {
                  rawItemTypes.add(parsed.itemType);
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
    "captures tool call inputs/outputs for commands, file changes, file reads, MCP tools, and web search",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const mcpServerScript = writeTestMcpServerScript(cwd);
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "auto",
        approvalPolicy: "on-request",
        networkAccess: true,
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
      } satisfies AgentSessionConfig;

      let session: AgentSession | null = null;
      let permissionRequest: AgentPermissionRequest | null = null;
      let permissionResolved = false;
      const toolCalls: ToolCallItem[] = [];

      try {
        session = await client.createSession(config);

        const prompt = [
          "1. Run the command `bash -lc \"printf 'stdout-marker'\"` using your shell tool.",
          "2. Run the command `bash -lc \"printf 'stderr-marker' 1>&2\"` using your shell tool.",
          "3. Use apply_patch (not the shell) to create a new file named tool-create.txt containing only the line 'alpha'.",
          "4. Use apply_patch (not the shell) to edit tool-create.txt, replacing 'alpha' with 'beta'.",
          "5. Use the read_file tool (not the shell) to read tool-create.txt.",
          "6. Call the MCP tool test.echo with input {\"text\":\"mcp-ok\"}.",
          "7. Use the web_search tool to search for \"OpenAI Codex MCP\".",
          "8. Request approval to run the command `printf \"permit\" > tool-permission.txt`, then run it.",
          "9. After all tools finish, reply DONE and stop.",
        ].join("\n");

        for await (const event of session.stream(prompt)) {
          if (event.type === "permission_requested" && !permissionRequest) {
            permissionRequest = event.request;
            await session.respondToPermission(permissionRequest.id, { behavior: "allow" });
          }
          if (
            event.type === "permission_resolved" &&
            permissionRequest &&
            event.requestId === permissionRequest.id &&
            event.resolution.behavior === "allow"
          ) {
            permissionResolved = true;
          }
          if (event.type === "timeline" && providerFromEvent(event) === "codex-mcp") {
            if (event.item.type === "tool_call" && event.item.server !== "permission") {
              toolCalls.push(event.item);
            }
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }

        expect.soft(permissionRequest).not.toBeNull();
        expect.soft(permissionResolved).toBe(true);

        const commandCalls = toolCalls.filter(
          (item) => item.server === "command" && item.status === "completed"
        );
        expect.soft(commandCalls.length).toBeGreaterThanOrEqual(2);

        const stdoutCall = commandCalls.find((item) =>
          (() => {
            const output = commandOutputText(item.output);
            return output ? output.includes("stdout-marker") : false;
          })()
        );
        const stderrCall = commandCalls.find((item) =>
          (() => {
            const output = commandOutputText(item.output);
            return output ? output.includes("stderr-marker") : false;
          })()
        );
        expect.soft(stdoutCall).toBeTruthy();
        expect.soft(stderrCall).toBeTruthy();
        expect.soft(extractExitCode(stdoutCall?.output)).toBe(0);
        expect.soft(extractExitCode(stderrCall?.output)).toBe(0);

        const fileChangeCalls = toolCalls.filter(
          (item) => item.server === "file_change" && item.tool === "apply_patch"
        );
        expect.soft(fileChangeCalls.length).toBeGreaterThanOrEqual(2);
        expect.soft(
          fileChangeCalls.some((item) => stringifyUnknown(item.input).includes("tool-create.txt"))
        ).toBe(true);
        expect.soft(
          fileChangeCalls.some((item) => stringifyUnknown(item.input).includes("alpha"))
        ).toBe(true);
        expect.soft(
          fileChangeCalls.some((item) => stringifyUnknown(item.input).includes("beta"))
        ).toBe(true);
        expect.soft(
          fileChangeCalls.some((item) => stringifyUnknown(item.output).includes("tool-create.txt"))
        ).toBe(true);

        const readCall = toolCalls.find((item) => item.tool === "read_file");
        expect.soft(readCall).toBeTruthy();
        expect.soft(stringifyUnknown(readCall?.input)).toContain("tool-create.txt");
        expect.soft(stringifyUnknown(readCall?.output)).toContain("beta");

        const mcpCall = toolCalls.find(
          (item) => item.server === "test" && item.tool === "echo"
        );
        expect.soft(mcpCall).toBeTruthy();
        expect.soft(stringifyUnknown(mcpCall?.input)).toContain("mcp-ok");
        expect.soft(stringifyUnknown(mcpCall?.output)).toContain("mcp-ok");

        const webSearchCall = toolCalls.find(
          (item) => item.server === "web_search" && item.tool === "web_search"
        );
        expect.soft(webSearchCall).toBeTruthy();
        expect.soft(stringifyUnknown(webSearchCall?.input)).toContain("OpenAI Codex MCP");
        expect.soft(webSearchCall?.output).toBeTruthy();

        const callIdStatuses = new Map<string, Set<string>>();
        for (const toolCall of toolCalls) {
          if (!toolCall.callId) {
            continue;
          }
          if (!callIdStatuses.has(toolCall.callId)) {
            callIdStatuses.set(toolCall.callId, new Set());
          }
          if (typeof toolCall.status === "string") {
            callIdStatuses.get(toolCall.callId)!.add(toolCall.status);
          }
        }
        const commandCallIds = toolCalls
          .filter((item) => item.server === "command")
          .map((item) => item.callId)
          .filter((callId): callId is string => typeof callId === "string");
        const fileChangeCallIds = toolCalls
          .filter((item) => item.server === "file_change")
          .map((item) => item.callId)
          .filter((callId): callId is string => typeof callId === "string");

        const hasCommandLifecycle = commandCallIds.some((callId) => {
          const statuses = callIdStatuses.get(callId);
          return statuses?.has("running") && statuses?.has("completed");
        });
        const hasFileChangeLifecycle = fileChangeCallIds.some((callId) => {
          const statuses = callIdStatuses.get(callId);
          return statuses?.has("running") && statuses?.has("completed");
        });
        expect.soft(hasCommandLifecycle).toBe(true);
        expect.soft(hasFileChangeLifecycle).toBe(true);
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    240_000
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
      } satisfies AgentSessionConfig;

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
      } satisfies AgentSessionConfig;

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
          handle.metadata ? getConversationIdFromMetadata(handle.metadata) : undefined;
        expect(typeof conversationId).toBe("string");
        expect(conversationId ? conversationId.length : 0).toBeGreaterThan(0);

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
          resumedHandle?.metadata
            ? getConversationIdFromMetadata(resumedHandle.metadata)
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
      } satisfies AgentSessionConfig;

      let session: AgentSession | null = null;

      try {
        session = await client.createSession(config);
        const result = await session.run("Reply READY and stop.");
        expect(result.finalText.toLowerCase()).toContain("ready");

        const info = await session.getRuntimeInfo();
        expect(info.provider).toBe("codex-mcp");
        expect(typeof info.sessionId).toBe("string");
        expect(info.sessionId ? info.sessionId.length : 0).toBeGreaterThan(0);
        expect(info.modeId).toBe("full-access");
        expect(typeof info.model).toBe("string");
        expect(info.model ? info.model.length : 0).toBeGreaterThan(0);
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
        modeId: "auto",
        approvalPolicy: "on-request",
      } satisfies AgentSessionConfig;
      const filePath = path.join(cwd, "permission.txt");

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

      const prompt = [
        "Request approval to run the command `printf \"ok\" > permission.txt`.",
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
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toContain("ok");
      } finally {
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );

  test(
    "requires permission in read-only (on-request) mode",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "read-only",
        approvalPolicy: "on-request",
      } satisfies AgentSessionConfig;

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

      const prompt = [
        "Request approval to run the command `printf \"ok\" > permission.txt`.",
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

        expect(captured).not.toBeNull();
        expect(
          timelineItems.some(
            (item) =>
              item.type === "tool_call" &&
              item.server === "permission" &&
              item.status === "requested"
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
    "denies permission requests and reports resolution",
    async () => {
      const cwd = tmpCwd();
      const restoreSessionDir = useTempCodexSessionDir();
      const { CodexMcpAgentClient } = await loadCodexMcpAgentClient();
      const client = new CodexMcpAgentClient();
      const config = {
        provider: "codex-mcp",
        cwd,
        modeId: "auto",
        approvalPolicy: "on-request",
      } satisfies AgentSessionConfig;
      const filePath = path.join(cwd, "permission.txt");

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionDenied = false;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

      const prompt = [
        "Request approval to run the command `printf \"ok\" > permission.txt`.",
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
        expect(existsSync(filePath)).toBe(false);
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
        modeId: "auto",
        approvalPolicy: "on-request",
      } satisfies AgentSessionConfig;
      const filePath = path.join(cwd, "permission.txt");

      let session: AgentSession | null = null;
      let captured: AgentPermissionRequest | null = null;
      let sawPermissionResolved = false;
      let sawTurnFailed = false;
      let failureMessage: string | null = null;
      const timelineItems: AgentTimelineItem[] = [];

      try {
        session = await client.createSession(config);

      const prompt = [
        "Request approval to run the command `printf \"ok\" > permission.txt`.",
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
        expect(sawTurnFailed).toBe(true);
        const message = failureMessage ? failureMessage : "";
        expect(message).toMatch(/aborted|interrupted/i);
        expect(existsSync(filePath)).toBe(false);
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
      } satisfies AgentSessionConfig;

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

  test(
    "interrupts long-running commands within 1s and leaves a clean session",
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
      } satisfies AgentSessionConfig;

      let session: AgentSession | null = null;
      let followupSession: AgentSession | null = null;
      let sawCommand = false;
      let interruptAt: number | null = null;
      let stoppedAt: number | null = null;
      const marker = `codex-mcp-abort-${randomUUID()}`;

      try {
        session = await client.createSession(config);
        const prompt = [
          `Run the exact shell command \`python3 -c "import time; time.sleep(300)" ${marker}\` using your shell tool.`,
          "Do not run any additional commands or send a response until that command finishes.",
        ].join(" ");

        const stream = session.stream(prompt);

        for await (const event of stream) {
          if (event.type === "permission_requested" && session) {
            await session.respondToPermission(event.request.id, { behavior: "allow" });
          }

          if (
            event.type === "timeline" &&
            providerFromEvent(event) === "codex-mcp" &&
            event.item.type === "tool_call" &&
            event.item.server === "command"
          ) {
            const commandText = commandTextFromInput(event.item.input);
            if (commandText && commandText.includes(marker)) {
              sawCommand = true;
              if (!interruptAt) {
                interruptAt = Date.now();
                await session.interrupt();
              }
            }
          }

          if (event.type === "turn_completed" || event.type === "turn_failed") {
            stoppedAt = Date.now();
            break;
          }
        }

        if (!interruptAt) {
          throw new Error("Did not issue interrupt for long-running command");
        }
        if (!stoppedAt) {
          stoppedAt = Date.now();
        }

        const latencyMs = stoppedAt - interruptAt;
        expect(sawCommand).toBe(true);
        expect(latencyMs).toBeGreaterThanOrEqual(0);
        expect(latencyMs).toBeLessThan(1_000);

        const exited = await waitForProcessExit(marker, 1_000);
        expect(exited).toBe(true);

        await session.close();
        session = null;

        followupSession = await client.createSession(config);
        const followup = await followupSession.run("Reply OK and stop.");
        expect(followup.finalText.toLowerCase()).toContain("ok");
      } finally {
        await session?.close();
        await followupSession?.close();
        rmSync(cwd, { recursive: true, force: true });
        restoreSessionDir();
      }
    },
    180_000
  );
});
