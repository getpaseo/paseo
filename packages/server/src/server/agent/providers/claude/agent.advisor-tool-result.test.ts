import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

const SESSION_ID = "advisor-tool-result-session";
const SUBAGENT_TOOL_USE_ID = "toolu_01SubagentAdvisor";
const SUBAGENT_ID = "a9988776655443322";

describe("ClaudeAgentSession advisor_tool_result handling", () => {
  const logger = createTestLogger();
  let tempRoot: string;
  let cwd: string;
  let configDir: string;

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

  function writeMainTranscript(entries: unknown[]): void {
    const file = transcriptPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  }

  async function resumeSession() {
    const client = new ClaudeAgentClient({
      logger,
      queryFactory: () => {
        throw new Error("replay must not start a query");
      },
      resolveBinary: async () => process.execPath,
      resolveVersion: async () => "2.1.332",
    });
    return client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd });
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-advisor-tool-result-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("settles redacted advisor_tool_result in main transcript replay without leaking encrypted_content", async () => {
    writeMainTranscript([
      {
        type: "user",
        uuid: "u-1",
        sessionId: SESSION_ID,
        message: { role: "user", content: "Check the architecture" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        sessionId: SESSION_ID,
        message: {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_1",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_1",
              content: {
                type: "advisor_redacted_result",
                encrypted_content: "SUPER_SECRET_CIPHERTEXT_PAYLOAD",
              },
            },
            { type: "text", text: "Here is the answer." },
          ],
        },
      },
    ]);

    const session = await resumeSession();
    try {
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }

      const advisorCalls = historyEvents
        .filter(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.callId === "srvtoolu_advisor_1",
        )
        .map((event) => event.item as ToolCallTimelineItem);

      expect(advisorCalls.at(-1)).toMatchObject({
        type: "tool_call",
        callId: "srvtoolu_advisor_1",
        name: "advisor",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: {}, output: null },
      });
      expect(JSON.stringify(advisorCalls)).not.toContain("SUPER_SECRET_CIPHERTEXT_PAYLOAD");

      // Interrupting after replay must not flush any stale canceled advisor tool calls.
      const postInterruptEvents: AgentStreamEvent[] = [];
      const unsubscribe = session.subscribe((event) => {
        postInterruptEvents.push(event);
      });
      await session.interrupt();
      unsubscribe();

      const canceledAdvisorCalls = postInterruptEvents.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "advisor" &&
          event.item.status === "canceled",
      );
      expect(canceledAdvisorCalls).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("handles advisor_result text and advisor_tool_result_error blocks", async () => {
    writeMainTranscript([
      {
        type: "assistant",
        uuid: "a-1",
        sessionId: SESSION_ID,
        message: {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_ok",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_ok",
              content: {
                type: "advisor_result",
                text: "Prefer streaming replay.",
              },
            },
            {
              type: "server_tool_use",
              id: "srvtoolu_advisor_err",
              name: "advisor",
              input: {},
            },
            {
              type: "advisor_tool_result",
              tool_use_id: "srvtoolu_advisor_err",
              content: {
                type: "advisor_tool_result_error",
                error_code: "max_uses_exceeded",
              },
            },
          ],
        },
      },
    ]);

    const session = await resumeSession();
    try {
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }

      const toolCalls = historyEvents
        .filter(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline" && event.item.type === "tool_call",
        )
        .map((event) => event.item as ToolCallTimelineItem);

      const okFinal = toolCalls.findLast((item) => item.callId === "srvtoolu_advisor_ok");
      expect(okFinal).toMatchObject({
        callId: "srvtoolu_advisor_ok",
        name: "advisor",
        status: "completed",
        detail: { type: "unknown", output: { output: "Prefer streaming replay." } },
      });

      const errFinal = toolCalls.findLast((item) => item.callId === "srvtoolu_advisor_err");
      expect(errFinal).toMatchObject({
        callId: "srvtoolu_advisor_err",
        name: "advisor",
        status: "failed",
      });
    } finally {
      await session.close();
    }
  });

  test("settles advisor_tool_result in subagent transcripts without leaking onto parent timeline", async () => {
    writeMainTranscript([
      {
        type: "assistant",
        sessionId: SESSION_ID,
        timestamp: "2026-11-26T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: SUBAGENT_TOOL_USE_ID,
              name: "Task",
              input: { subagent_type: "general-purpose", description: "Audit advisor calls" },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: SESSION_ID,
        timestamp: "2026-11-26T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: SUBAGENT_TOOL_USE_ID,
              content: `agentId: ${SUBAGENT_ID}\ndone`,
              is_error: false,
            },
          ],
        },
      },
    ]);

    const subagentsDir = path.join(
      claudeProjectDirSync(cwd, { configDir }),
      SESSION_ID,
      "subagents",
    );
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, `agent-${SUBAGENT_ID}.jsonl`),
      [
        {
          type: "assistant",
          isSidechain: true,
          agentId: SUBAGENT_ID,
          sessionId: SESSION_ID,
          timestamp: "2026-11-26T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_sub_advisor_1",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "srvtoolu_sub_advisor_1",
                content: {
                  type: "advisor_redacted_result",
                  encrypted_content: "SUBAGENT_SECRET_PAYLOAD",
                },
              },
              { type: "text", text: "Subagent finished." },
            ],
            stop_reason: "end_turn",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const session = await resumeSession();
    try {
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }

      const subagentAdvisorCalls = historyEvents
        .filter(
          (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
            event.type === "provider_subagent" &&
            event.event.type === "timeline" &&
            event.event.item.type === "tool_call" &&
            event.event.item.callId === "srvtoolu_sub_advisor_1",
        )
        .map((event) =>
          event.event.type === "timeline" ? (event.event.item as ToolCallTimelineItem) : null,
        );

      expect(subagentAdvisorCalls.at(-1)).toMatchObject({
        type: "tool_call",
        callId: "srvtoolu_sub_advisor_1",
        name: "advisor",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: {}, output: null },
      });
      expect(JSON.stringify(subagentAdvisorCalls)).not.toContain("SUBAGENT_SECRET_PAYLOAD");

      // Interrupting the parent must not flush the subagent's advisor call onto the parent timeline.
      const postInterruptEvents: AgentStreamEvent[] = [];
      const unsubscribe = session.subscribe((event) => {
        postInterruptEvents.push(event);
      });
      await session.interrupt();
      unsubscribe();

      const leakedAdvisorCalls = postInterruptEvents.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "advisor",
      );
      expect(leakedAdvisorCalls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
