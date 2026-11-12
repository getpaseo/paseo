import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import { ACPAgentSession } from "./acp-agent.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";

type StopReason = "end_turn" | "cancelled" | "refusal";
interface PromptResult {
  stopReason: StopReason;
  usage?: { outputTokens?: number };
}

interface SessionInternals {
  sessionId: string | null;
  connection: unknown;
  historyPending: boolean;
  persistedHistory: AgentTimelineItem[];
}

interface SessionHarness {
  session: ACPAgentSession;
  brainDir: string;
  sessionId: string;
  events: AgentStreamEvent[];
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  answer(response: PromptResult): Promise<void>;
  writeTranscript(rows: unknown[], fullRows?: unknown[]): void;
}

async function flushAsyncIo(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await setImmediate();
  }
}

function summarizeEvents(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "timeline") {
      if (event.item.type === "reasoning") {
        return [`reasoning:${event.item.text}`];
      }
      if (event.item.type === "assistant_message") {
        return [`assistant:${event.item.text}`];
      }
      if (event.item.type === "tool_call") {
        return [`tool:${event.item.name}:${event.item.status}`];
      }
      return [];
    }
    if (
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed"
    ) {
      return [event.type];
    }
    return [];
  });
}

describe("ACP Antigravity background turn and transcript catch-up", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    tempDirs = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createHarness(options?: {
    provider?: string;
    defaultCommand?: [string, ...string[]];
    subscribeOnInit?: boolean;
  }): SessionHarness {
    const brainDir = mkdtempSync(path.join(tmpdir(), "paseo-agy-brain-"));
    tempDirs.push(brainDir);
    const sessionId = "session-agy-1";
    const provider = options?.provider ?? "antigravity";
    const defaultCommand = options?.defaultCommand ?? ["agy", "acp"];

    const session = new ACPAgentSession(
      { provider, cwd: "/tmp/paseo-agy-test" },
      {
        provider,
        logger: createTestLogger(),
        defaultCommand,
        defaultModes: [],
        capabilities: {
          supportsMcpServers: false,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsModelSelection: true,
          supportsReasoningConfig: true,
        },
        antigravityBrainDir: brainDir,
        antigravityPollIntervalMs: 100,
        antigravitySubscribeCatchupMs: 50,
      },
    );

    let resolvePrompt: ((response: PromptResult) => void) | null = null;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResult>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const cancel = vi.fn(async () => {});
    const internals = asInternals<SessionInternals>(session);
    internals.sessionId = sessionId;
    internals.connection = {
      prompt,
      cancel,
      signal: new AbortController().signal,
    };

    const events: AgentStreamEvent[] = [];
    if (options?.subscribeOnInit !== false) {
      session.subscribe((event) => events.push(event));
    }

    const logsDir = path.join(brainDir, sessionId, ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });

    return {
      session,
      brainDir,
      sessionId,
      events,
      prompt,
      cancel,
      answer: async (response) => {
        if (!resolvePrompt) {
          throw new Error("startTurn did not issue a prompt");
        }
        resolvePrompt(response);
        await flushAsyncIo();
      },
      writeTranscript: (rows, fullRows) => {
        writeFileSync(
          path.join(logsDir, "transcript.jsonl"),
          `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
          "utf8",
        );
        if (fullRows) {
          writeFileSync(
            path.join(logsDir, "transcript_full.jsonl"),
            `${fullRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
          );
        }
      },
    };
  }

  test("plain end_turn without background work completes immediately and does not repeat foreground replies", async () => {
    const { session, events, answer, writeTranscript } = createHarness();
    writeTranscript([
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "hello" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Done right away.",
        tool_calls: [],
      },
    ]);

    await session.startTurn("hello");
    // Subscriber joins while session/prompt is still in flight.
    session.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(50);
    await flushAsyncIo();
    await answer({ stopReason: "end_turn" });

    expect(summarizeEvents(events)).toEqual(["turn_completed"]);
    expect(await session.canStopRuntime()).toBe(true);
  });

  test("daemon background task (IsDaemon: true) does not hold the turn", async () => {
    const { session, events, answer, writeTranscript } = createHarness();
    writeTranscript([
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "start dev server" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            id: "call-daemon",
            name: "run_command",
            args: JSON.stringify({
              CommandLine: "pnpm dev",
              IsDaemon: true,
              toolSummary: "Start dev server",
            }),
          },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Tool is running as a background task with task id: session-agy-1/task-daemon",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Dev server is running.",
        tool_calls: [],
      },
    ]);

    await session.startTurn("start dev server");
    await answer({ stopReason: "end_turn" });

    expect(summarizeEvents(events)).toEqual(["turn_completed"]);
    expect(await session.canStopRuntime()).toBe(true);
  });

  test("non-daemon background task holds end_turn, streams wakeup steps, and completes", async () => {
    const { session, events, answer, writeTranscript } = createHarness({
      provider: "acp",
      defaultCommand: ["/Users/admin/.local/bin/agy", "acp", "--dangerously-skip-permissions"],
    });

    const baseRows = [
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "deploy and verify" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [
          {
            id: "call-1",
            name: "run_command",
            args: JSON.stringify({
              CommandLine: "pnpm test && pnpm deploy",
              IsDaemon: false,
              toolSummary: "Run pre-commit gate",
            }),
          },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Tool is running as a background task with task id: session-agy-1/task-7",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Running pre-commit checks; will deploy once they pass.",
        tool_calls: [],
      },
    ];
    writeTranscript(baseRows);

    await session.startTurn("deploy and verify");
    await answer({ stopReason: "end_turn" });

    // Premature end_turn is held open while task-7 is running in the background.
    expect(summarizeEvents(events)).toEqual([]);
    expect(await session.canStopRuntime()).toBe(false);

    // Background task finishes and triggers a reactive wakeup with truncated thinking
    // and a follow-up tool call before the final assistant reply.
    const wakeupRows = [
      ...baseRows,
      {
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-12T10:36:00.200Z",
        content:
          '[Message] timestamp=2026-11-12T10:36:00Z sender=session-agy-1/task-7 content=Task id "session-agy-1/task-7" finished',
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        thinking: "short preview...",
        truncated_fields: ["thinking"],
        tool_calls: [
          {
            id: "call-2",
            name: "run_command",
            args: JSON.stringify({
              CommandLine: "curl -fsS https://example.com/health",
              toolSummary: "Verify live health",
            }),
          },
        ],
      },
      {
        step_index: 7,
        type: "GENERIC",
        status: "DONE",
        content: "HTTP 200 OK",
      },
      {
        step_index: 8,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        thinking: "Health check succeeded.",
        content: "Deployment and live health verification passed.",
        tool_calls: [],
      },
    ];
    const fullRows = [
      ...wakeupRows.slice(0, 5),
      {
        ...wakeupRows[5],
        thinking: "Full untruncated reasoning from transcript_full.jsonl.",
        truncated_fields: undefined,
      },
      ...wakeupRows.slice(6),
    ];
    writeTranscript(wakeupRows, fullRows);

    await vi.advanceTimersByTimeAsync(100);
    await flushAsyncIo();

    expect(summarizeEvents(events)).toEqual([
      "reasoning:Full untruncated reasoning from transcript_full.jsonl.",
      "tool:execute:completed",
      "reasoning:Health check succeeded.",
      "assistant:Deployment and live health verification passed.",
      "turn_completed",
    ]);
    expect(await session.canStopRuntime()).toBe(true);

    // Next turn: agy acp replays the wakeup steps before streaming the new turn's reply.
    events.length = 0;
    await session.startTurn("what next?");

    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Full untruncated reasoning from transcript_full.jsonl.",
        },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replayed-call-2",
        title: "Verify live health",
        kind: "execute",
        status: "in_progress",
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "replayed-call-2",
        status: "completed",
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Health check succeeded." },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "replayed-msg",
        content: {
          type: "text",
          text: "Deployment and ",
        },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "replayed-msg",
        content: {
          type: "text",
          text: "live health verification passed.",
        },
      } as SessionUpdate,
    });
    // Fresh update from the new turn must still be delivered.
    await session.sessionUpdate({
      sessionId: "session-agy-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "fresh-msg",
        content: { type: "text", text: "Ready for the next step." },
      } as SessionUpdate,
    });

    expect(summarizeEvents(events)).toEqual(["assistant:Ready for the next step."]);
  });

  test("background subagent holds end_turn across >80 intermediate steps until its SYSTEM_MESSAGE arrives", async () => {
    const { session, events, answer, writeTranscript } = createHarness();
    const intermediateSteps = Array.from({ length: 85 }, (_, offset) => ({
      step_index: 4 + offset,
      type: "GENERIC",
      status: "DONE",
      content: `intermediate tool result ${offset + 1}`,
    }));
    const baseRows = [
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "audit with subagent" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ id: "sub-1", name: "invoke_subagent", args: '{"Role":"Auditor"}' }],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content:
          'Created the following subagent:\n{"conversationId": "subagent-uuid-42", "role": "Auditor"}',
      },
      ...intermediateSteps,
      {
        step_index: 89,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Waiting for the auditor subagent.",
        tool_calls: [],
      },
    ];
    writeTranscript(baseRows);

    await session.startTurn("audit with subagent");
    await answer({ stopReason: "end_turn" });

    expect(summarizeEvents(events)).toEqual([]);
    expect(await session.canStopRuntime()).toBe(false);

    writeTranscript([
      ...baseRows,
      {
        step_index: 90,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-12T11:00:05.100Z",
        content:
          "[Message] timestamp=2026-11-12T11:00:05Z sender=subagent-uuid-42 content=Audit complete: 0 issues.",
      },
      {
        step_index: 91,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Auditor subagent finished with 0 issues.",
        tool_calls: [],
      },
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await flushAsyncIo();

    expect(summarizeEvents(events)).toEqual([
      "assistant:Auditor subagent finished with 0 issues.",
      "turn_completed",
    ]);
    expect(await session.canStopRuntime()).toBe(true);
  });

  test("cancelled background task releases the held turn when manage_task reports killed", async () => {
    const { session, events, answer, writeTranscript } = createHarness();
    const baseRows = [
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "run check" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ id: "call-quiet", name: "run_command", args: '{"CommandLine":"sleep 60"}' }],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Tool is running as a background task with task id: session-agy-1/task-quiet",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Waiting.",
        tool_calls: [],
      },
    ];
    writeTranscript(baseRows);

    await session.startTurn("run check");
    await answer({ stopReason: "end_turn" });

    // Quiet task stays held until completion or cancellation evidence appears in transcript.
    expect(summarizeEvents(events)).toEqual([]);
    expect(await session.canStopRuntime()).toBe(false);

    writeTranscript([
      ...baseRows,
      null,
      { step_index: 5, type: "GENERIC", status: "DONE", content: 12345 },
      {
        step_index: 6,
        type: "GENERIC",
        status: "DONE",
        content: "Task session-agy-1/task-quiet was killed.",
      },
      {
        step_index: 7,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Task cancelled.",
        tool_calls: [],
      },
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await flushAsyncIo();

    expect(summarizeEvents(events)).toEqual(["turn_completed"]);
    expect(await session.canStopRuntime()).toBe(true);
  });

  test("subscribe catch-up keeps polling reopened busy chats and streams wakeup when it finishes", async () => {
    const { session, writeTranscript } = createHarness({ subscribeOnInit: false });
    const internals = asInternals<SessionInternals>(session);
    internals.historyPending = true;
    internals.persistedHistory.push({
      type: "assistant_message",
      text: "stale cached item",
      messageId: "stale-1",
    });

    const runningRows = [
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "ship it" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ id: "call-ship", name: "run_command", args: '{"CommandLine":"pnpm ship"}' }],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Tool is running as a background task with task id: session-agy-1/task-ship",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Starting background check.",
        tool_calls: [],
      },
    ];
    writeTranscript(runningRows);

    const lateSubscriberEvents: AgentStreamEvent[] = [];
    session.subscribe((event) => lateSubscriberEvents.push(event));

    await vi.advanceTimersByTimeAsync(50);
    await flushAsyncIo();

    expect(internals.historyPending).toBe(false);
    expect(summarizeEvents(lateSubscriberEvents)).toEqual([]);

    // Wakeup finishes on the next poll while no foreground prompt is active.
    writeTranscript([
      ...runningRows,
      {
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-12T10:40:00.000Z",
        content:
          "[Message] timestamp=2026-11-12T10:40:00Z sender=session-agy-1/task-ship content=Done",
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        thinking: "All checks green.",
        content: "Shipped and verified.",
        tool_calls: [],
      },
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await flushAsyncIo();

    expect(summarizeEvents(lateSubscriberEvents)).toEqual([
      "reasoning:All checks green.",
      "assistant:Shipped and verified.",
    ]);
  });

  test("interrupt during a held background turn cancels immediately", async () => {
    const { session, events, cancel, answer, writeTranscript } = createHarness();
    writeTranscript([
      { step_index: 1, type: "USER_INPUT", status: "DONE", content: "long background job" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ id: "call-bg", name: "run_command", args: '{"CommandLine":"sleep 60"}' }],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Tool is running as a background task with task id: session-agy-1/task-99",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Started background job.",
        tool_calls: [],
      },
    ]);

    await session.startTurn("long background job");
    await answer({ stopReason: "end_turn" });
    expect(summarizeEvents(events)).toEqual([]);

    await session.interrupt();

    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-agy-1" });
    expect(summarizeEvents(events)).toEqual(["turn_canceled"]);
  });
});
