import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

/**
 * Replay coverage for provider subagents rebuilt from a persisted session.
 *
 * The live path had tests; this path did not, which is how its derivation drifted from the live
 * one. These exercise the real on-disk layout Claude Code writes.
 */

const TOOL_USE_ID = "toolu_01DgLoPMW9";
const AGENT_ID = "a1730a6215e1f5cf6";

function parentEntry(content: unknown): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "replay-session",
    timestamp: "2026-07-26T06:27:47.034Z",
    message: { role: "assistant", content },
  });
}

function taskToolUse(): string {
  return parentEntry([
    {
      type: "tool_use",
      id: TOOL_USE_ID,
      name: "Task",
      input: { subagent_type: "general-purpose", description: "Summarize the docs" },
    },
  ]);
}

function taskToolResult(options: { isError?: boolean; mentionAgentId?: boolean } = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: "replay-session",
    timestamp: "2026-07-26T06:28:00.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: TOOL_USE_ID,
          content: options.mentionAgentId === false ? "done" : `agentId: ${AGENT_ID}\ndone`,
          is_error: options.isError === true,
        },
      ],
    },
  });
}

function sidechainEntry(): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId: AGENT_ID,
    sessionId: "replay-session",
    timestamp: "2026-07-26T06:27:50.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "summary of the docs" }] },
  });
}

describe("ClaudeAgentSession persisted subagent replay", () => {
  const logger = createTestLogger();
  const queryFactory = vi.fn(() => {
    throw new Error("replay must not start a query");
  });
  let tempRoot: string;
  let cwd: string;
  let configDir: string;

  function writeSession(options: {
    parentLines: string[];
    meta?: string | null;
    sidechainLines?: string[];
  }): void {
    const historyDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(path.join(historyDir, "replay-session.jsonl"), options.parentLines.join("\n"));

    const subagentDir = path.join(historyDir, "replay-session", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      path.join(subagentDir, `agent-${AGENT_ID}.jsonl`),
      (options.sidechainLines ?? [sidechainEntry()]).join("\n"),
    );
    if (options.meta !== null && options.meta !== undefined) {
      writeFileSync(path.join(subagentDir, `agent-${AGENT_ID}.meta.json`), options.meta);
    }
  }

  async function replayDescriptors(): Promise<
    Extract<AgentStreamEvent, { type: "provider_subagent" }>[]
  > {
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: "replay-session" },
      { cwd },
    );
    const events: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "provider_subagent") events.push(event);
    }
    await session.close();
    return events;
  }

  function upserts(events: Extract<AgentStreamEvent, { type: "provider_subagent" }>[]) {
    return events.map((e) => e.event).filter((e) => e.type === "upsert");
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-subagent-replay-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("links a subagent to its Task call through the meta sidecar", async () => {
    writeSession({
      parentLines: [taskToolUse(), taskToolResult()],
      meta: JSON.stringify({
        agentType: "general-purpose",
        description: "Summarize the docs",
        toolUseId: TOOL_USE_ID,
        spawnDepth: 1,
      }),
    });

    const declared = upserts(await replayDescriptors())[0];
    expect(declared).toMatchObject({
      id: TOOL_USE_ID,
      toolCallId: TOOL_USE_ID,
      title: "general-purpose",
      description: "Summarize the docs",
    });
  });

  test("links through the meta sidecar even when the parent's tool_result is missing", async () => {
    // The regression the sidecar exists to fix: with no tool_result there is nothing to scrape,
    // and the subagent used to degrade to a generic title with no tool call attached.
    writeSession({
      parentLines: [taskToolUse()],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID, agentType: "Explore" }),
    });

    const declared = upserts(await replayDescriptors())[0];
    expect(declared).toMatchObject({ id: TOOL_USE_ID, toolCallId: TOOL_USE_ID });
    expect(declared).not.toMatchObject({ title: "Claude subagent" });
  });

  test("falls back to the legacy scrape when no meta sidecar exists", async () => {
    writeSession({ parentLines: [taskToolUse(), taskToolResult()], meta: null });

    const events = upserts(await replayDescriptors());
    expect(events[0]).toMatchObject({ id: TOOL_USE_ID, title: "general-purpose" });
    expect(events.at(-1)).toMatchObject({ status: "completed" });
  });

  test("carries a failed outcome through to the descriptor", async () => {
    writeSession({
      parentLines: [taskToolUse(), taskToolResult({ isError: true })],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID }),
    });

    expect(upserts(await replayDescriptors()).at(-1)).toMatchObject({ status: "failed" });
  });

  test("leaves a subagent running when the transcript records no outcome", async () => {
    writeSession({
      parentLines: [taskToolUse()],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID }),
    });

    // Asserted as "nothing terminal" rather than "every upsert says running": a subtitle-only
    // upsert carries no status, so presentation arriving after completion cannot revert a child.
    const statuses = upserts(await replayDescriptors()).map((event) => event.status);
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("failed");
    expect(statuses).toContain("running");
  });

  test.each([
    ["truncated json", '{"toolUseId":"toolu_01DgLoPMW9"'],
    ["not json", "toolUseId: toolu"],
    ["empty file", ""],
    ["a json array", "[1,2,3]"],
  ])("survives a malformed meta sidecar (%s)", async (_label, contents) => {
    writeSession({ parentLines: [taskToolUse(), taskToolResult()], meta: contents });

    // Falls back to the scrape rather than losing the subagent.
    const events = upserts(await replayDescriptors());
    expect(events[0]).toMatchObject({ id: TOOL_USE_ID });
  });

  test("replays the subagent's own transcript onto its timeline", async () => {
    writeSession({
      parentLines: [taskToolUse(), taskToolResult()],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID }),
    });

    const timeline = (await replayDescriptors())
      .map((event) => event.event)
      .filter((event) => event.type === "timeline");
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0]).toMatchObject({ id: TOOL_USE_ID });
  });
});
