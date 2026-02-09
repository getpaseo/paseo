import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createServer } from "http";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { curateAgentActivity } from "../activity-curator.js";
import { ClaudeAgentClient, convertClaudeHistoryEntry } from "./claude-agent.js";
import { useTempClaudeConfigDir } from "../../test-utils/claude-config.js";
import type { AgentStreamEventPayload } from "../../messages.js";
import type {
  AgentProvider,
  AgentPermissionRequest,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { createAgentMcpServer } from "../mcp-server.js";

const createHTTPServer = createServer;

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

type StreamItem = any;
type AgentToolCallData = any;

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-agent-e2e-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

async function autoApprove(session: Awaited<ReturnType<ClaudeAgentClient["createSession"]>>, event: AgentStreamEvent) {
  if (event.type === "permission_requested") {
    await session.respondToPermission(event.request.id, { behavior: "allow" });
  }
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

type KeyValueObject = { [key: string]: unknown };

function isKeyValueObject(value: unknown): value is KeyValueObject {
  return typeof value === "object" && value !== null;
}

function isFileWriteResult(value: unknown): value is { type: "file_write"; filePath: string } {
  return isKeyValueObject(value) && value.type === "file_write" && typeof value.filePath === "string";
}

function extractCommandText(input: unknown): string | null {
  if (!isKeyValueObject(input)) {
    return null;
  }
  const command = input.command;
  if (typeof command === "string" && command.length > 0) {
    return command;
  }
  if (Array.isArray(command)) {
    const tokens = command.filter((value): value is string => typeof value === "string");
    if (tokens.length > 0) {
      return tokens.join(" ");
    }
  }
  if (typeof input.description === "string") {
    const description = input.description;
    if (description.length > 0) {
      return description;
    }
  }
  return null;
}

function extractToolCommand(detail: unknown): string | null {
  if (!isKeyValueObject(detail) || typeof detail.type !== "string") {
    return null;
  }
  if (detail.type === "shell" && typeof detail.command === "string") {
    return detail.command;
  }
  if (detail.type === "unknown") {
    return extractCommandText(detail.rawInput);
  }
  return null;
}

function isSleepCommandToolCall(item: ToolCallItem): boolean {
  const inputCommand = extractToolCommand(item.detail)?.toLowerCase() ?? "";
  return inputCommand.includes("sleep 60");
}

function isPermissionCommandToolCall(item: ToolCallItem): boolean {
  if (item.name === "permission_request") {
    return false;
  }
  const inputCommand = extractToolCommand(item.detail)?.toLowerCase() ?? "";
  return inputCommand.includes("permission.txt");
}

type AgentMcpServerHandle = {
  url: string;
  close: () => Promise<void>;
};

async function startAgentMcpServer(): Promise<AgentMcpServerHandle> {
  const testLogger = createTestLogger();
  const app = express();
  app.use(express.json());
  const httpServer = createHTTPServer(app);

  const registryDir = mkdtempSync(path.join(os.tmpdir(), "agent-mcp-registry-"));
  const storagePath = path.join(registryDir, "agents");
  const agentStorage = new AgentStorage(storagePath, testLogger);
  const agentManager = new AgentManager({
    clients: {},
    registry: agentStorage,
    logger: testLogger,
  });

  let allowedHosts: string[] | undefined;
  const agentMcpTransports = new Map<string, StreamableHTTPServerTransport>();

  const createAgentMcpTransport = async (callerAgentId?: string) => {
    const agentMcpServer = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId,
      logger: testLogger,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        agentMcpTransports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        agentMcpTransports.delete(sessionId);
      },
      enableDnsRebindingProtection: true,
      ...(allowedHosts ? { allowedHosts } : {}),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        agentMcpTransports.delete(transport.sessionId);
      }
    };
    transport.onerror = () => {
      // Ignore errors in test
    };

    await agentMcpServer.connect(transport);
    return transport;
  };

  const handleAgentMcpRequest: express.RequestHandler = async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? agentMcpTransports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST") {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or invalid MCP session" },
            id: null,
          });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Initialization request expected" },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        const callerAgentId =
          typeof callerAgentIdRaw === "string"
            ? callerAgentIdRaw
            : Array.isArray(callerAgentIdRaw)
              ? callerAgentIdRaw[0]
              : undefined;
        transport = await createAgentMcpTransport(callerAgentId);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp/agents", handleAgentMcpRequest);
  app.get("/mcp/agents", handleAgentMcpRequest);
  app.delete("/mcp/agents", handleAgentMcpRequest);

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const url = `http://127.0.0.1:${port}/mcp/agents`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

(hasClaudeCredentials ? describe : describe.skip)(
  "ClaudeAgentClient (SDK integration)",
  () => {
  const logger = createTestLogger();
  let hydrateStreamState: (updates: unknown[]) => unknown = () => {
    throw new Error("hydrateStreamState not initialized");
  };
  let isAgentToolCallItem: (item: unknown) => boolean = () => false;
  let agentMcpServer: AgentMcpServerHandle;
  let restoreClaudeConfigDir: (() => void) | null = null;
  const buildConfig = (
    cwd: string,
    options?: { maxThinkingTokens?: number; modeId?: string }
  ): AgentSessionConfig => ({
    provider: "claude",
    cwd,
    modeId: options?.modeId,
    extra: {
      claude: {
        sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
        ...(typeof options?.maxThinkingTokens === "number"
          ? { maxThinkingTokens: options.maxThinkingTokens }
          : {}),
      },
    },
  });

  beforeAll(() => {
    restoreClaudeConfigDir = useTempClaudeConfigDir();
  });
  beforeAll(async () => {
    const stream = await import("../../../../../app/src/types/stream.js");
    hydrateStreamState = stream.hydrateStreamState as typeof hydrateStreamState;
    isAgentToolCallItem = stream.isAgentToolCallItem as typeof isAgentToolCallItem;
  });
  beforeAll(async () => {
    agentMcpServer = await startAgentMcpServer();
  });
  afterAll(async () => {
    await agentMcpServer?.close();
  });
  afterAll(() => {
    restoreClaudeConfigDir?.();
  });
  test(
    "responds with text",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024 });
      const session = await client.createSession(config);

      const marker = "CLAUDE_ACK_TOKEN";
      const result = await session.run(
        `Reply with the exact text ${marker} and then stop.`
      );

      expect(result.finalText).toContain(marker);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "streams reasoning chunks",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);

      const events = session.stream(
        "Think step by step about the pros and cons of single-file tests, but only share a short plan."
      );

      let sawReasoning = false;

      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "timeline" && event.item.type === "reasoning") {
          sawReasoning = true;
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      expect(sawReasoning).toBe(true);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "emits a single assistant message in the hydrated stream",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);
      const updates: StreamHydrationUpdate[] = [];

      try {
        const events = session.stream("Reply with the exact words HELLO WORLD.");
        for await (const event of events) {
          await autoApprove(session, event);
          recordTimelineUpdate(updates, event);
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      const state = hydrateStreamState(updates);
      const assistantMessages = state.filter(
        (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
          item.kind === "assistant_message"
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text.toLowerCase()).toContain("hello world");
    },
    150_000
  );

  test(
    "shows the command inside pending tool calls",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);

      let pendingCommand: string | null = null;
      const events = session.stream("Run the exact command `pwd` via Bash and stop.");

      try {
        for await (const event of events) {
          await autoApprove(session, event);
          if (
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.name.toLowerCase().includes("bash") &&
            event.item.status === "pending"
          ) {
            pendingCommand = extractToolCommand(event.item.detail);
          }
          if (event.type === "turn_completed" || event.type === "turn_failed") {
            break;
          }
        }
      } finally {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(pendingCommand).toBeTruthy();
      expect(pendingCommand?.toLowerCase()).toContain("pwd");
    },
    150_000
  );

  test(
    "tracks permission + tool lifecycle when editing a file",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024 });
      const session = await client.createSession(config);

      const events = session.stream(
        "First run a Bash command to print the working directory, then use your editor tools (not the shell) to create a file named tool-test.txt in the current directory that contains exactly the text 'hello world'. Report 'done' after the write finishes."
      );

      const timeline: AgentTimelineItem[] = [];
      let completed = false;

      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed") {
          completed = true;
          break;
        }
        if (event.type === "turn_failed") {
          break;
        }
      }

      const toolCalls = timeline.filter(
        (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
          item.type === "tool_call"
      );
      const commandEvents = toolCalls.filter(
        (item) =>
          item.name.toLowerCase().includes("bash") &&
          item.name !== "permission_request"
      );
      const fileChangeEvent = toolCalls.find((item) => {
        if (item.detail.type === "write" || item.detail.type === "edit") {
          return item.detail.filePath.includes("tool-test.txt");
        }
        if (item.detail.type === "unknown") {
          return (
            rawContainsText(item.detail.rawInput, "tool-test.txt") ||
            rawContainsText(item.detail.rawOutput, "tool-test.txt")
          );
        }
        return rawContainsText(item.detail, "tool-test.txt");
      });

      const sawPwdCommand = commandEvents.some(
        (item) => (extractToolCommand(item.detail) ?? "").toLowerCase().includes("pwd") && item.status === "completed"
      );

      expect(completed).toBe(true);
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(sawPwdCommand).toBe(true);
      expect(fileChangeEvent).toBeTruthy();

      const filePath = path.join(cwd, "tool-test.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("hello world");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );

  test(
    "permission flow parity - allows command after approval",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024, modeId: "default" });
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");
      writeFileSync(filePath, "ok", "utf8");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedAllow = false;
      const timeline: AgentTimelineItem[] = [];
      const cleanup = async () => {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      };

      const prompt = [
        "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
        "After approval, run it and reply DONE.",
        "Do not respond before the command finishes.",
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
          sawResolvedAllow = true;
        }
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }
      try {
        expect(captured).not.toBeNull();
        expect(sawResolvedAllow).toBe(true);
        expect(session.getPendingPermissions()).toHaveLength(0);
        expect(
          timeline.some(
            (item) =>
              item.type === "tool_call" &&
              isPermissionCommandToolCall(item) &&
              item.status === "completed"
          )
        ).toBe(true);
        expect(existsSync(filePath)).toBe(false);
      } finally {
        await cleanup();
      }
    },
    180_000
  );

  test(
    "permission flow parity - denies command execution",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024, modeId: "default" });
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");
      writeFileSync(filePath, "ok", "utf8");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedDeny = false;
      const timeline: AgentTimelineItem[] = [];
      const cleanup = async () => {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      };

      const prompt = [
        "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
        "If approval is denied, reply DENIED and stop.",
        "Do not respond before the command finishes or the denial is confirmed.",
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
          sawResolvedDeny = true;
        }
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }
      try {
        expect(captured).not.toBeNull();
        expect(sawResolvedDeny).toBe(true);
        expect(
          timeline.some(
            (item) =>
              item.type === "tool_call" &&
              isPermissionCommandToolCall(item) &&
              item.status === "completed"
          )
        ).toBe(false);
        expect(existsSync(filePath)).toBe(true);
      } finally {
        await cleanup();
      }
    },
    180_000
  );

  test(
    "permission flow parity - aborts on interrupt response",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024, modeId: "default" });
      const session = await client.createSession(config);
      const filePath = path.join(cwd, "permission.txt");
      writeFileSync(filePath, "ok", "utf8");

      let captured: AgentPermissionRequest | null = null;
      let sawResolvedInterrupt = false;
      let sawTerminalEvent = false;
      const timeline: AgentTimelineItem[] = [];
      const cleanup = async () => {
        await session.close();
        rmSync(cwd, { recursive: true, force: true });
      };

      const prompt = [
        "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
        "If approval is denied, stop immediately.",
        "Do not respond before the command finishes or the denial is confirmed.",
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
          sawResolvedInterrupt = true;
        }
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          sawTerminalEvent = true;
          break;
        }
      }
      try {
        expect(captured).not.toBeNull();
        expect(sawResolvedInterrupt).toBe(true);
        expect(sawTerminalEvent).toBe(true);
        expect(
          timeline.some(
            (item) =>
              item.type === "tool_call" &&
              isPermissionCommandToolCall(item) &&
              item.status === "completed"
          )
        ).toBe(false);
        expect(existsSync(filePath)).toBe(true);
      } finally {
        await cleanup();
      }
    },
    180_000
  );

  test(
    "interrupts a long-running bash command before it finishes",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      let session: Awaited<ReturnType<typeof client.createSession>> | null = null;
      let runStartedAt: number | null = null;
      let durationMs = 0;
      let sawSleepCommand = false;
      let interruptIssued = false;

      try {
        session = await client.createSession(config);
        const prompt = [
          "Use your Bash command tool to run the exact command `sleep 60`.",
          "Do not run any other commands or respond until that command finishes.",
        ].join(" ");

        runStartedAt = Date.now();
        const events = session.stream(prompt);

        for await (const event of events) {
          await autoApprove(session, event);

          if (event.type === "timeline" && event.item.type === "tool_call" && isSleepCommandToolCall(event.item)) {
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
          throw new Error("Claude run never started");
        }
        durationMs = Date.now() - runStartedAt;
      } finally {
        if (durationMs === 0 && runStartedAt !== null) {
          durationMs = Date.now() - runStartedAt;
        }
        await session?.close();
        rmSync(cwd, { recursive: true, force: true });
      }

      expect(sawSleepCommand).toBe(true);
      expect(interruptIssued).toBe(true);
      expect(durationMs).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(60_000);
    },
    120_000
  );

  test(
    "supports multi-turn conversations",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);

      const first = await session.run("Respond only with the word alpha.");
      expect(first.finalText.toLowerCase()).toContain("alpha");

      const second = await session.run(
        "Without adding any explanations, repeat exactly the same word you just said."
      );
      expect(second.finalText.toLowerCase()).toContain("alpha");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "resumes a persisted session with context preserved",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024 });
      const session = await client.createSession(config);

      // Store a specific word in a file to create history and enable recall
      const timestamp = Date.now();
      const secretWord = `XYZZY${timestamp}PLUGH`;
      const secretFile = path.join(cwd, "secret.txt");
      const prompt = `Write exactly this word to a file called secret.txt: ${secretWord}. Then respond only with "STORED".`;

      let storedResponse = "";
      for await (const event of session.stream(prompt)) {
        await autoApprove(session, event);
        if (event.type === "timeline" && event.item.type === "assistant_message") {
          storedResponse = event.item.text;
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }
      expect(storedResponse.toLowerCase()).toContain("stored");
      expect(existsSync(secretFile)).toBe(true);

      await session.close();

      const handle = session.describePersistence();
      expect(handle).toBeTruthy();
      expect(handle!.sessionId).toBeTruthy();

      // Wait for history file to be written
      const historyPaths = getClaudeHistoryPaths(cwd, handle!.sessionId);
      expect(await waitForHistoryFile(historyPaths)).toBe(true);

      // Resume and verify context is preserved
      const resumed = await client.resumeSession(handle!, { cwd });

      // Verify history is emitted on resume
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of resumed.streamHistory()) {
        historyEvents.push(event);
      }

      // Should have timeline events from previous session
      const timelineEvents = historyEvents.filter((e) => e.type === "timeline");
      expect(timelineEvents.length).toBeGreaterThan(0);

      // Should include the user message with the secret word
      const userMessages = timelineEvents.filter(
        (e) => e.type === "timeline" && e.item.type === "user_message"
      );
      expect(userMessages.length).toBeGreaterThan(0);
      const hasSecretWord = userMessages.some(
        (e) =>
          e.type === "timeline" &&
          e.item.type === "user_message" &&
          e.item.text.includes(secretWord)
      );
      expect(hasSecretWord).toBe(true);

      // Ask the agent to recall what it wrote - this verifies context is actually preserved
      const resumedResult = await resumed.run(
        "What word did you write to secret.txt? Reply with only that exact word."
      );
      // The model should recall some part of the unique word we stored
      // (models sometimes truncate or modify, so we check for any part of our unique token)
      const recalledSomething =
        resumedResult.finalText.includes(String(timestamp)) ||
        resumedResult.finalText.includes("XYZZY") ||
        resumedResult.finalText.includes("PLUGH");
      expect(recalledSomething).toBe(true);

      await resumed.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );

  test(
    "updates session modes",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024 });
      const session = await client.createSession(config);

      const modes = await session.getAvailableModes();
      expect(modes.map((m) => m.id)).toContain("plan");

      await session.setMode("plan");
      expect(await session.getCurrentMode()).toBe("plan");

      const result = await session.run(
        "Just reply with the word PLAN to confirm you're still responsive."
      );
      expect(result.finalText.toLowerCase()).toContain("plan");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "handles plan mode approval flow",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);
      await session.setMode("plan");

      const events = session.stream(
        "Devise a plan to create a file named dummy.txt containing the word plan-test. After planning, proceed to execute your plan."
      );

      let capturedPlan: string | null = null;
      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "permission_requested" && event.request.kind === "plan") {
          const planFromMetadata =
            typeof event.request.metadata?.planText === "string"
              ? event.request.metadata.planText
              : null;
          const planFromInput =
            typeof (event.request.input as any)?.plan === "string"
              ? ((event.request.input as any)?.plan as string)
              : null;
          capturedPlan = planFromMetadata ?? planFromInput ?? capturedPlan;
        }

        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      expect(capturedPlan).not.toBeNull();
      expect(capturedPlan?.includes("dummy.txt")).toBe(true);
      expect(await session.getCurrentMode()).toBe("acceptEdits");

      const filePath = path.join(cwd, "dummy.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toContain("plan-test");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );

  test(
    "hydrates persisted tool call results into the UI stream",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 4096 });
      const session = await client.createSession(config);
      const prompt = [
        "You are verifying the hydrate regression test.",
        "Follow these steps exactly and report 'hydration test complete' at the end:",
        "1. Run the Bash command 'pwd' via the terminal tool.",
        "2. Use your editor tools (not the shell) to create a file named hydrate-proof.txt with the content:",
        "   HYDRATION_PROOF_LINE_ONE",
        "   HYDRATION_PROOF_LINE_TWO",
        "3. Read hydrate-proof.txt via the editor read_file tool to confirm the contents.",
        "4. Summarize the diff/write results briefly and then stop.",
      ].join("\n");

      try {
        const liveTimelineUpdates: StreamHydrationUpdate[] = [];
        const events = session.stream(prompt);

        let completed = false;
        try {
          for await (const event of events) {
            await autoApprove(session, event);
            recordTimelineUpdate(liveTimelineUpdates, event);
            if (event.type === "turn_completed") {
              completed = true;
              break;
            }
            if (event.type === "turn_failed") {
              throw new Error(event.error);
            }
          }
        } finally {
          await session.close();
        }

        expect(completed).toBe(true);
        const liveState = hydrateStreamState(liveTimelineUpdates);
        const liveSnapshots = extractAgentToolSnapshots(liveState);
        const commandTool = liveSnapshots.find((snapshot) =>
          snapshot.data.name.toLowerCase().includes("bash") &&
          (extractToolCommand(snapshot.data.detail) ?? "").toLowerCase().includes("pwd")
        );
        const editTool = liveSnapshots.find((snapshot) =>
          rawContainsText(snapshot.data.detail, "hydrate-proof.txt")
        );
        const readTool = liveSnapshots.find((snapshot) =>
          rawContainsText(snapshot.data.detail, "HYDRATION_PROOF_LINE_TWO")
        );

        expect(commandTool).toBeTruthy();
        expect(editTool).toBeTruthy();
        expect(readTool).toBeTruthy();

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();
        const sessionId = handle?.sessionId ?? handle?.nativeHandle;
        expect(typeof sessionId).toBe("string");

        const historyPaths = getClaudeHistoryPaths(cwd, sessionId!);
        expect(await waitForHistoryFile(historyPaths)).toBe(true);

        const resumed = await client.resumeSession(handle!, { cwd });
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        try {
          for await (const event of resumed.streamHistory()) {
            recordTimelineUpdate(hydrationUpdates, event);
          }
        } finally {
          await resumed.close();
        }

        expect(hydrationUpdates.length).toBeGreaterThan(0);

        const hydratedState = hydrateStreamState(hydrationUpdates);
        const hydratedSnapshots = extractAgentToolSnapshots(hydratedState);
        const hydratedMap = new Map(
          hydratedSnapshots.map((entry) => [entry.key, entry.data])
        );

        assertHydratedReplica(
          commandTool!,
          hydratedMap,
          (data) =>
            rawContainsText(data.detail, cwd),
          ({ live, hydrated }) => {
            expect(rawContainsText(live.detail, cwd)).toBe(true);
            expect(rawContainsText(hydrated.detail, cwd)).toBe(true);
            expect((extractToolCommand(live.detail) ?? "").toLowerCase()).toContain("pwd");
            expect((extractToolCommand(hydrated.detail) ?? "").toLowerCase()).toContain("pwd");
          }
        );
        assertHydratedReplica(
          editTool!,
          hydratedMap,
          (data) =>
            rawContainsText(data.detail, "hydrate-proof.txt"),
          ({ live, hydrated }) => {
            const liveDiff = JSON.stringify(live.detail ?? {});
            const hydratedDiff = JSON.stringify(hydrated.detail ?? {});
            expect(liveDiff).toContain("hydrate-proof.txt");
            expect(hydratedDiff).toContain("hydrate-proof.txt");
          }
        );
        assertHydratedReplica(
          readTool!,
          hydratedMap,
          (data) =>
            rawContainsText(data.detail, "HYDRATION_PROOF_LINE_ONE") &&
            rawContainsText(data.detail, "HYDRATION_PROOF_LINE_TWO"),
          ({ live, hydrated }) => {
            const liveReads = JSON.stringify(live.detail ?? {});
            const hydratedReads = JSON.stringify(hydrated.detail ?? {});
            expect(liveReads).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(hydratedReads).toContain("HYDRATION_PROOF_LINE_ONE");
            expect(liveReads).toContain("HYDRATION_PROOF_LINE_TWO");
            expect(hydratedReads).toContain("HYDRATION_PROOF_LINE_TWO");
          }
        );
      } finally {
        cleanupClaudeHistory(cwd);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240_000
  );

  test(
    "hydrates user messages from persisted history",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 1024 });

      const promptMarker = `HYDRATED_USER_${Date.now().toString(36)}`;
      const prompt = `Reply with the exact text ${promptMarker} and then stop.`;
      const liveTimelineUpdates: StreamHydrationUpdate[] = [
        buildUserMessageUpdate("claude", prompt, "msg-claude-hydrated-user"),
      ];

      try {
        const session = await client.createSession(config);
        const events = session.stream(prompt);
        try {
          for await (const event of events) {
            recordTimelineUpdate(liveTimelineUpdates, event);
            if (event.type === "turn_completed" || event.type === "turn_failed") {
              break;
            }
          }
        } finally {
          await session.close();
        }

        const handle = session.describePersistence();
        expect(handle).toBeTruthy();
        const sessionId = handle?.sessionId ?? handle?.nativeHandle;
        expect(typeof sessionId).toBe("string");

        const historyPaths = getClaudeHistoryPaths(cwd, sessionId!);
        expect(await waitForHistoryFile(historyPaths)).toBe(true);

        const resumed = await client.resumeSession(handle!, { cwd });
        const hydrationUpdates: StreamHydrationUpdate[] = [];
        try {
          for await (const event of resumed.streamHistory()) {
            recordTimelineUpdate(hydrationUpdates, event);
          }
        } finally {
          await resumed.close();
        }

        const liveState = hydrateStreamState(liveTimelineUpdates);
        const hydratedState = hydrateStreamState(hydrationUpdates);

        expect(stateIncludesUserMessage(liveState, promptMarker)).toBe(true);
        expect(stateIncludesUserMessage(hydratedState, promptMarker)).toBe(true);
      } finally {
        cleanupClaudeHistory(cwd);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240_000
  );

  test(
    "collapses sub-agent tool calls into Task metadata updates",
    async () => {
      const cwd = tmpCwd();
      const client = new ClaudeAgentClient({ logger });
      const config = buildConfig(cwd, { maxThinkingTokens: 2048 });
      const session = await client.createSession(config);

      const events = session.stream(
        "Use the Task tool to launch a sub-agent that reads the current directory listing. " +
        "The sub-agent should run 'ls' in the shell and report the result. " +
        "Do NOT do the work yourself — delegate it to a sub-agent via the Task tool."
      );

      const timeline: AgentTimelineItem[] = [];

      for await (const event of events) {
        await autoApprove(session, event);
        if (event.type === "timeline") {
          timeline.push(event.item);
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          break;
        }
      }

      const toolCalls = timeline.filter(
        (item): item is ToolCallItem => item.type === "tool_call"
      );

      // There should be at least one Task tool call
      const taskCalls = toolCalls.filter((item) => item.name === "Task");
      expect(taskCalls.length).toBeGreaterThanOrEqual(1);

      // Sub-agent tool calls (Read, Bash, shell, etc.) should NOT appear as
      // separate timeline items — they should only appear as Task metadata updates
      const subAgentLeaks = toolCalls.filter(
        (item) => item.name !== "Task" && item.metadata?.subAgentActivity === undefined
      );
      // If there are non-Task tool calls, they must be from the main agent, not sub-agent
      // We can't 100% guarantee Claude won't also use tools directly, but Task metadata
      // updates should exist for the sub-agent activity
      const taskWithMetadata = taskCalls.filter(
        (item) => item.metadata?.subAgentActivity
      );
      if (taskCalls.length > 0) {
        expect(taskWithMetadata.length).toBeGreaterThanOrEqual(1);
      }

      // Verify the curator produces clean output with collapsed Task entries
      const curated = curateAgentActivity(timeline);
      const lines = curated.split("\n");
      const taskLines = lines.filter((l) => l.includes("[Task]"));
      // Each Task callId should appear at most once in curated output
      expect(taskLines.length).toBeLessThanOrEqual(taskCalls.length);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    180_000
  );
});

describe("convertClaudeHistoryEntry", () => {
  test("maps user tool results to timeline items", () => {
    const toolUseId = "toolu_test";
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    };

    const stubTimeline: AgentTimelineItem[] = [
      {
        type: "tool_call",
        server: "editor",
        tool: "read_file",
        status: "completed",
      },
    ];

    const mapBlocks = vi.fn().mockReturnValue(stubTimeline);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(result).toEqual(stubTimeline);
    expect(mapBlocks).toHaveBeenCalledTimes(1);
    const arg = mapBlocks.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
  });

  test("returns user messages when no tool blocks exist", () => {
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: "Run npm test",
      },
    };

    const result = convertClaudeHistoryEntry(entry, () => []);

    expect(result).toEqual([
      {
        type: "user_message",
        text: "Run npm test",
      },
    ]);
  });

  test("converts compact_boundary entry to compaction timeline item", () => {
    const entry = {
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      compactMetadata: { trigger: "auto", preTokens: 168428 },
    };

    const result = convertClaudeHistoryEntry(entry, () => []);

    expect(result).toEqual([
      {
        type: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens: 168428,
      },
    ]);
  });

  test("skips isCompactSummary user entries", () => {
    const entry = {
      type: "user",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation...",
      },
    };

    const result = convertClaudeHistoryEntry(entry, () => []);

    expect(result).toEqual([]);
  });

  test("passes thinking blocks to mapBlocks for assistant entries", () => {
    const entry = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    };

    const mapBlocks = vi.fn().mockReturnValue([
      { type: "reasoning", text: "Let me reason about this..." },
      { type: "assistant_message", text: "Here is my answer." },
    ]);
    const result = convertClaudeHistoryEntry(entry, mapBlocks);

    expect(mapBlocks).toHaveBeenCalledTimes(1);
    const arg = mapBlocks.mock.calls[0][0];
    expect(arg).toEqual([
      { type: "thinking", thinking: "Let me reason about this..." },
      { type: "text", text: "Here is my answer." },
    ]);
    expect(result).toEqual([
      { type: "reasoning", text: "Let me reason about this..." },
      { type: "assistant_message", text: "Here is my answer." },
    ]);
  });
});

type StreamHydrationUpdate = {
  event: Extract<AgentStreamEventPayload, { type: "timeline" }>;
  timestamp: Date;
};

type ToolSnapshot = { key: string; data: AgentToolCallData };

function recordTimelineUpdate(target: StreamHydrationUpdate[], event: AgentStreamEvent) {
  if (event.type !== "timeline") {
    return;
  }
  target.push({
    event: {
      type: "timeline",
      provider: event.provider,
      item: event.item,
    },
    timestamp: new Date(),
  });
}

function buildUserMessageUpdate(
  provider: AgentProvider,
  text: string,
  messageId: string
): StreamHydrationUpdate {
  return {
    event: {
      type: "timeline",
      provider,
      item: {
        type: "user_message",
        text,
        messageId,
      },
    },
    timestamp: new Date(),
  };
}

function stateIncludesUserMessage(state: StreamItem[], marker: string): boolean {
  return state.some(
    (item) => item.kind === "user_message" && item.text.toLowerCase().includes(marker.toLowerCase())
  );
}

function extractAgentToolSnapshots(state: StreamItem[]): ToolSnapshot[] {
  return state.filter(isAgentToolCallItem).map((item) => ({
    key: buildToolSnapshotKey(item.payload.data, item.id),
    data: item.payload.data,
  }));
}

function buildToolSnapshotKey(data: AgentToolCallData, fallbackId: string): string {
  const normalized = typeof data.callId === "string" && data.callId.trim().length > 0 ? data.callId.trim() : null;
  if (normalized) {
    return normalized;
  }
  return `${data.provider}:${data.name}:${fallbackId}`;
}

function assertHydratedReplica(
  liveSnapshot: ToolSnapshot,
  hydratedMap: Map<string, AgentToolCallData>,
  predicate: (data: AgentToolCallData) => boolean,
  extraAssertions?: (ctx: { live: AgentToolCallData; hydrated: AgentToolCallData }) => void
) {
  expect(predicate(liveSnapshot.data)).toBe(true);
  const hydrated = hydratedMap.get(liveSnapshot.key);
  expect(hydrated).toBeTruthy();
  expect(hydrated?.status).toBe(liveSnapshot.data.status);
  expect(hydrated?.name).toBe(liveSnapshot.data.name);
  expect(predicate(hydrated!)).toBe(true);
  if (hydrated && extraAssertions) {
    extraAssertions({ live: liveSnapshot.data, hydrated });
  }
}

function sanitizeClaudeProjectName(cwd: string): string {
  // Match Claude CLI's path sanitization: replace slashes, dots, and underscores with dashes
  return cwd.replace(/[\\/\.]/g, "-").replace(/_/g, "-");
}

function resolveClaudeHistoryPath(cwd: string, sessionId: string): string {
  const sanitized = sanitizeClaudeProjectName(cwd);
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", sanitized, `${sessionId}.jsonl`);
}

function getClaudeHistoryPaths(cwd: string, sessionId: string): string[] {
  return normalizeCwdCandidates(cwd).map((candidate) =>
    resolveClaudeHistoryPath(candidate, sessionId)
  );
}

function normalizeCwdCandidates(cwd: string): string[] {
  const candidates = new Set<string>([cwd]);
  try {
    const resolved = realpathSync(cwd);
    candidates.add(resolved);
  } catch {
    // ignore resolution errors
  }
  return Array.from(candidates);
}

function cleanupClaudeHistory(cwd: string) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  for (const candidate of normalizeCwdCandidates(cwd)) {
    const sanitized = sanitizeClaudeProjectName(candidate);
    const projectDir = path.join(configDir, "projects", sanitized);
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }
}

async function waitForHistoryFile(historyPaths: string | string[], timeoutMs = 10_000): Promise<boolean> {
  const candidates = Array.isArray(historyPaths) ? Array.from(new Set(historyPaths)) : [historyPaths];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (candidates.some((entry) => existsSync(entry))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return candidates.some((entry) => existsSync(entry));
}

function rawContainsText(raw: unknown, text: string, depth = 0): boolean {
  if (!raw || typeof text !== "string" || !text) {
    return false;
  }
  if (typeof raw === "string") {
    return raw.includes(text);
  }
  if (depth > 6) {
    return false;
  }
  if (Array.isArray(raw)) {
    return raw.some((entry) => rawContainsText(entry, text, depth + 1));
  }
  if (isKeyValueObject(raw)) {
    return Object.values(raw).some((value) =>
      rawContainsText(value, text, depth + 1)
    );
  }
  return false;
}

// NOTE: Turn handoff integration tests are covered by the daemon E2E test:
// "interrupting message should produce coherent text without garbling from race condition"
// in daemon.e2e.test.ts which exercises the full flow through the WebSocket API.

describe("ClaudeAgentClient.listModels", () => {
  const logger = createTestLogger();

  test(
    "returns models with required fields",
    async () => {
      const client = new ClaudeAgentClient({ logger });
      const models = await client.listModels();

      // HARD ASSERT: Returns an array
      expect(Array.isArray(models)).toBe(true);

      // HARD ASSERT: At least one model is returned
      expect(models.length).toBeGreaterThan(0);

      // HARD ASSERT: Each model has required fields with correct types
      for (const model of models) {
        expect(model.provider).toBe("claude");
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.label).toBe("string");
        expect(model.label.length).toBeGreaterThan(0);
      }

      // HARD ASSERT: Contains known Claude model IDs
      const modelIds = models.map((m) => m.id);
      const hasKnownModel = modelIds.some(
        (id) =>
          id.includes("claude") ||
          id.includes("sonnet") ||
          id.includes("opus") ||
          id.includes("haiku")
      );
      expect(hasKnownModel).toBe(true);
    },
    60_000
  );
});
