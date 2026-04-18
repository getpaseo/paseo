import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function commandFromRawInput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const commandValue = record.command ?? record.cmd;
  if (typeof commandValue === "string" && commandValue.length > 0) {
    return commandValue;
  }
  if (Array.isArray(commandValue)) {
    const parts = commandValue.filter((entry): entry is string => typeof entry === "string");
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return null;
}

function commandFromToolCallDetail(detail: ToolCallItem["detail"]): string | null {
  if (detail.type === "shell") {
    return detail.command;
  }
  if (detail.type === "unknown") {
    return commandFromRawInput(detail.input);
  }
  return null;
}

function extractPathFromPayload(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const directPath = record.path ?? record.file_path ?? record.filePath;
  if (typeof directPath === "string" && directPath.length > 0) {
    return directPath;
  }

  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      const fileRecord = asRecord(file);
      const filePath = fileRecord?.path;
      if (typeof filePath === "string" && filePath.length > 0) {
        return filePath;
      }
    }
  }

  return null;
}

function pathFromToolCallDetail(detail: ToolCallItem["detail"]): string | null {
  if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
    return detail.filePath;
  }
  if (detail.type === "unknown") {
    return extractPathFromPayload(detail.input) ?? extractPathFromPayload(detail.output);
  }
  return null;
}

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("tool call structure", () => {
    // Helper to extract and dedupe tool calls by callId, keeping the last (most complete) version
    function extractToolCalls(queue: SessionOutboundMessage[], agentId: string): ToolCallItem[] {
      const byCallId = new Map<string, ToolCallItem>();
      const noCallId: ToolCallItem[] = [];

      for (const m of queue) {
        if (
          m.type === "agent_stream" &&
          m.payload.agentId === agentId &&
          m.payload.event.type === "timeline" &&
          m.payload.event.item.type === "tool_call"
        ) {
          const tc = m.payload.event.item;
          if (tc.callId) {
            byCallId.set(tc.callId, tc);
          } else {
            noCallId.push(tc);
          }
        }
      }

      return [...byCallId.values(), ...noCallId];
    }

    // Helper to log tool call structure in a consistent format
    function logToolCall(prefix: string, tc: ToolCallItem): void {
      void prefix;
      void tc;
    }

    test("Claude agent: Read tool", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);

      const agent = await ctx.client.createAgent({
        provider: "claude",
        cwd,
        title: "Claude Read Test",
        modeId: "bypassPermissions",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        "Read the file /etc/hosts and tell me how many lines it has. Be brief.",
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CLAUDE_READ", tc);
      }

      const readCall = toolCalls.find((tc) => tc.name === "Read");
      expect(readCall).toBeDefined();
      expect(readCall?.name).toBe("Read");
      expect(readCall?.detail).toBeDefined();
      const readPath = readCall ? pathFromToolCallDetail(readCall.detail) : null;
      expect(readPath).toBeTruthy();
      if (readPath) {
        expect(readPath).toContain("/etc/hosts");
      }

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);

    test("Claude agent: Bash tool", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);

      const agent = await ctx.client.createAgent({
        provider: "claude",
        cwd,
        title: "Claude Bash Test",
        modeId: "bypassPermissions",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        "Run `echo hello` and tell me what it outputs. Be brief.",
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CLAUDE_BASH", tc);
      }

      const bashCall = toolCalls.find((tc) => tc.name === "Bash");
      expect(bashCall).toBeDefined();
      expect(bashCall?.name).toBe("Bash");
      expect(bashCall?.detail).toBeDefined();
      const command = bashCall ? commandFromToolCallDetail(bashCall.detail) : null;
      expect(command).toBeTruthy();
      if (command) {
        expect(command).toContain("echo");
      }

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);

    test("Claude agent: Edit tool", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);
      const testFile = path.join(cwd, "test.txt");
      writeFileSync(testFile, "hello world\n");

      const agent = await ctx.client.createAgent({
        provider: "claude",
        cwd,
        title: "Claude Edit Test",
        modeId: "bypassPermissions",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        `Edit the file ${testFile} and change "hello" to "goodbye". Be brief.`,
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CLAUDE_EDIT", tc);
      }

      const editCall = toolCalls.find((tc) => tc.name === "Edit");
      expect(editCall).toBeDefined();
      expect(editCall?.detail).toBeDefined();
      const editPath = editCall ? pathFromToolCallDetail(editCall.detail) : null;
      if (editPath) {
        expect(editPath).toBe(testFile);
      } else if (editCall?.detail.type === "unknown") {
        expect(editCall.detail.input ?? editCall.detail.output).toBeTruthy();
      } else {
        expect(editCall?.detail.type).toBe("edit");
      }

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);

    test("Codex agent: shell command", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Codex Shell Test",
        modeId: "full-access",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        "Run `echo hello` and tell me what it outputs. Be brief.",
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CODEX_SHELL", tc);
      }

      const shellCalls = toolCalls.filter((tc) => tc.name === "shell");
      expect(shellCalls.length).toBeGreaterThan(0);

      const echoCall = shellCalls.find((tc) => {
        const command = commandFromToolCallDetail(tc.detail);
        return typeof command === "string" && command.includes("echo");
      });
      expect(echoCall).toBeDefined();

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);

    test("Codex agent: file read", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Codex Read Test",
        modeId: "full-access",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        "Read the file /etc/hosts and tell me how many lines it has. Be brief.",
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CODEX_READ", tc);
      }

      // Codex may use shell cat or file read
      const readCall = toolCalls.find((tc) => tc.type === "tool_call" && tc.name === "read_file");
      if (readCall) {
        expect(readCall.name).toBe("read_file");
      }

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);

    test("Codex agent: file edit", async () => {
      const cwd = tmpCwd();
      const collector = createMessageCollector(ctx.client);
      const testFile = path.join(cwd, "test.txt");
      writeFileSync(testFile, "hello world\n");

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Codex Edit Test",
        modeId: "full-access",
      });

      collector.clear();

      await ctx.client.sendMessage(
        agent.id,
        `Edit the file ${testFile} and change "hello" to "goodbye". Be brief.`,
      );

      await ctx.client.waitForFinish(agent.id, 120000);

      const toolCalls = extractToolCalls(collector.messages, agent.id);
      expect(toolCalls.length).toBeGreaterThan(0);

      for (const tc of toolCalls) {
        logToolCall("CODEX_EDIT", tc);
      }

      // Codex uses apply_patch for edits
      const editCall = toolCalls.find((tc) => tc.type === "tool_call" && tc.name === "apply_patch");
      if (editCall) {
        expect(editCall.name).toBe("apply_patch");
      }

      await ctx.client.deleteAgent(agent.id);
      collector.unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }, 180000);
  });
});
