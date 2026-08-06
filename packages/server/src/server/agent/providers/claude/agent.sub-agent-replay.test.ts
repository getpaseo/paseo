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
const WORKFLOW_TOOL_USE_ID = "toolu_01XskpjeASyuFyXC5qsLHYps";
const WORKFLOW_RUN_ID = "wf_4a0af4f7-f56";

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

function sidechainEntry(options: { agentId?: string; stopReason?: string | null } = {}): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId: options.agentId ?? AGENT_ID,
    sessionId: "replay-session",
    timestamp: "2026-07-26T06:27:50.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "summary of the docs" }],
      stop_reason: options.stopReason ?? null,
    },
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

  function writeParentSession(parentLines: string[]): string {
    const historyDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(path.join(historyDir, "replay-session.jsonl"), parentLines.join("\n"));
    return path.join(historyDir, "replay-session", "subagents");
  }

  function writeSubagent(options: {
    subagentDir: string;
    agentId?: string;
    meta?: string | null;
    sidechainLines?: string[];
  }): void {
    const agentId = options.agentId ?? AGENT_ID;
    mkdirSync(options.subagentDir, { recursive: true });
    writeFileSync(
      path.join(options.subagentDir, `agent-${agentId}.jsonl`),
      (options.sidechainLines ?? [sidechainEntry({ agentId })]).join("\n"),
    );
    if (options.meta !== null && options.meta !== undefined) {
      writeFileSync(path.join(options.subagentDir, `agent-${agentId}.meta.json`), options.meta);
    }
  }

  function writeSession(options: {
    parentLines: string[];
    meta?: string | null;
    sidechainLines?: string[];
  }): void {
    writeSubagent({
      subagentDir: writeParentSession(options.parentLines),
      meta: options.meta,
      sidechainLines: options.sidechainLines,
    });
  }

  function writeWorkflowSession(
    status: string,
    options: {
      children?: { agentId: string; output: string; timestamp: string }[];
    } = {},
  ): void {
    const subagentDirectory = writeParentSession([
      parentEntry([
        {
          type: "tool_use",
          id: WORKFLOW_TOOL_USE_ID,
          name: "Workflow",
          input: { scriptPath: "/tmp/one-child.js", args: "{}" },
        },
      ]),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: WORKFLOW_TOOL_USE_ID,
              content: `Workflow launched in background.\nRun ID: ${WORKFLOW_RUN_ID}`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: WORKFLOW_RUN_ID,
        tool_use_id: WORKFLOW_TOOL_USE_ID,
        status: "completed",
        summary: "Workflow completed",
        output_file: "/tmp/workflow.output",
      }),
    ]);
    const workflowDirectory = path.join(path.dirname(subagentDirectory), "workflows");
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(
      path.join(workflowDirectory, `${WORKFLOW_RUN_ID}.json`),
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        summary: "Verify the workflow row lifecycle",
        status,
        startTime: 1786003484150,
        timestamp: "2026-08-06T08:04:46.347Z",
        defaultModel: "claude-sonnet-5",
        totalTokens: 20_417,
      }),
    );
    for (const child of options.children ?? []) {
      const workflowChildDirectory = path.join(subagentDirectory, "workflows", WORKFLOW_RUN_ID);
      writeSubagent({
        subagentDir: workflowChildDirectory,
        agentId: child.agentId,
        meta: JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }),
        sidechainLines: [
          JSON.stringify({
            type: "assistant",
            isSidechain: true,
            agentId: child.agentId,
            sessionId: "replay-session",
            timestamp: child.timestamp,
            message: {
              role: "assistant",
              content: [{ type: "text", text: child.output }],
              stop_reason: "end_turn",
            },
          }),
        ],
      });
    }
  }

  async function replayEvents(): Promise<AgentStreamEvent[]> {
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: "replay-session" },
      { cwd },
    );
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      events.push(event);
    }
    await session.close();
    return events;
  }

  async function replayDescriptors(): Promise<
    Extract<AgentStreamEvent, { type: "provider_subagent" }>[]
  > {
    return (await replayEvents()).filter((event) => event.type === "provider_subagent");
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

  test("finishes a Task subagent from its own end_turn when the parent outcome is missing", async () => {
    writeSession({
      parentLines: [taskToolUse()],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID }),
      sidechainLines: [sidechainEntry({ stopReason: "end_turn" })],
    });

    expect(upserts(await replayDescriptors()).at(-1)).toMatchObject({
      id: TOOL_USE_ID,
      status: "completed",
    });
  });

  test("does not replay a skill-spawned subagent the parent never named", async () => {
    // The reported bug. A /code-review subagent has no Task tool_use, so its sidecar carries only
    // agentType and its id appears nowhere in the parent — it used to replay as running forever,
    // and every reopen resurrected it.
    writeSession({
      parentLines: [parentEntry([{ type: "text", text: "running /code-review" }])],
      meta: JSON.stringify({ agentType: "general-purpose" }),
      sidechainLines: [sidechainEntry({ stopReason: "end_turn" })],
    });

    expect(upserts(await replayDescriptors())).toEqual([]);
  });

  test("does not accumulate internal workflow agents as replay-only running rows", async () => {
    const subagentRoot = writeParentSession([
      parentEntry([
        {
          type: "tool_use",
          id: "toolu_workflow",
          name: "Workflow",
          input: { script: "await Promise.all([agent('one'), agent('two'), agent('three')])" },
        },
      ]),
    ]);
    const workflowDir = path.join(subagentRoot, "workflows", "wf_c240e728-6ea");

    for (const agentId of ["a17a341a0902f5799", "ae2d01ba2dfa46032", "abc9f20546c326c53"]) {
      writeSubagent({
        subagentDir: workflowDir,
        agentId,
        meta: JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }),
        sidechainLines: [sidechainEntry({ agentId, stopReason: "end_turn" })],
      });
    }

    expect(upserts(await replayDescriptors())).toEqual([]);
  });

  test("replays a completed workflow as one generic provider-subagent row", async () => {
    writeWorkflowSession("completed", {
      children: [
        {
          agentId: "a-later-child",
          output: "later workflow child result",
          timestamp: "2026-08-06T08:04:45.500Z",
        },
        {
          agentId: "z-earlier-child",
          output: "earlier workflow child result",
          timestamp: "2026-08-06T08:04:45.000Z",
        },
      ],
    });

    const replayed = await replayEvents();
    const descriptors = replayed.filter((event) => event.type === "provider_subagent");
    const events = upserts(descriptors);
    expect(events[0]).toMatchObject({
      id: WORKFLOW_TOOL_USE_ID,
      toolCallId: WORKFLOW_TOOL_USE_ID,
      title: "Workflow",
      description: "Verify the workflow row lifecycle",
      status: "running",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ subtitle: "Workflow · Sonnet 5 · 20.4k tokens" }),
    );
    expect(events.at(-1)).toMatchObject({
      id: WORKFLOW_TOOL_USE_ID,
      status: "completed",
    });
    expect(descriptors).toContainEqual({
      type: "provider_subagent",
      provider: "claude",
      event: {
        type: "timeline",
        id: WORKFLOW_TOOL_USE_ID,
        item: expect.objectContaining({
          type: "assistant_message",
          text: "earlier workflow child result",
        }),
        timestamp: "2026-08-06T08:04:45.000Z",
      },
    });
    expect(new Set(events.map((event) => event.id))).toEqual(new Set([WORKFLOW_TOOL_USE_ID]));
    const workflowOutputs = descriptors
      .map((event) => event.event)
      .filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
      .map((event) => (event.item.type === "assistant_message" ? event.item.text : ""));
    expect(workflowOutputs).toEqual([
      "earlier workflow child result",
      "later workflow child result",
    ]);
    expect(
      replayed
        .filter((event) => event.type === "timeline")
        .map((event) => event.item)
        .filter((item) => item.type === "tool_call" && item.name === "task_notification"),
    ).toEqual([]);
  });

  test("does not replay a subagent whose toolUseId names no Task call in this transcript", async () => {
    // A grandchild recorded before spawnDepth existed: the Task call it names was made inside a
    // sibling's session, so no tool_result for it can ever reach this parent.
    writeSession({
      parentLines: [parentEntry([{ type: "text", text: "no task calls here" }])],
      meta: JSON.stringify({ toolUseId: TOOL_USE_ID, agentType: "Explore" }),
      sidechainLines: [sidechainEntry({ stopReason: "end_turn" })],
    });

    expect(upserts(await replayDescriptors())).toEqual([]);
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
