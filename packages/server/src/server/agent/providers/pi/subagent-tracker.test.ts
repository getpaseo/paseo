import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { PiSubagentTracker } from "./subagent-tracker.js";
import { streamPiHistory } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

const noopLogger = pino({ level: "silent" });

const SUBAGENT_TOOL_CALL_ID = "call_subagent_1";
const RUN_ID = "run-1";

function subagentArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: "explore", task: "Find auth code", ...overrides };
}

function runDetails(results: Record<string, unknown>[]): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "single",
      runId: RUN_ID,
      results,
    },
  };
}

function childSessionLines(): string[] {
  return [
    JSON.stringify({
      type: "session",
      id: "child-session",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "message",
      id: "m1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Task: Find auth code" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "looking" },
          { type: "text", text: "Found it in src/auth.ts" },
        ],
      },
    }),
  ];
}

async function collect(generator: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("PiSubagentTracker", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("start with subagent args emits a running descriptor", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    const events = tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    expect(events).toEqual([
      {
        type: "provider_subagent",
        provider: "pi",
        event: {
          type: "upsert",
          id: SUBAGENT_TOOL_CALL_ID,
          title: "explore",
          description: "Find auth code",
          status: "running",
          toolCallId: SUBAGENT_TOOL_CALL_ID,
        },
      },
    ]);
  });

  test("start ignores non-subagent tool args", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    expect(tracker.start(SUBAGENT_TOOL_CALL_ID, { command: "ls" })).toEqual([]);
    expect(tracker.start(SUBAGENT_TOOL_CALL_ID, null)).toEqual([]);
  });

  test("update emits descriptor when progress adds a subtitle", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = tracker.update(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ progress: { activityState: "reading", model: "nous_portal/ox-alpha" } }]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("provider_subagent");
    if (events[0]!.type === "provider_subagent" && events[0]!.event.type === "upsert") {
      expect(events[0]!.event.subtitle).toBe("reading · ox-alpha");
    }
  });

  test("update without new presentation emits nothing", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const first = tracker.update(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ progress: { activityState: "reading" } }]),
    );
    expect(first).toHaveLength(1);
    const repeat = tracker.update(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ progress: { activityState: "reading" } }]),
    );
    expect(repeat).toEqual([]);
  });

  test("end re-keys descriptor to run id and streams child timeline", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, childSessionLines().join("\n"), "utf8");

    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = await tracker.end(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ agent: "explore", exitCode: 0, sessionFile }]),
      false,
    );

    const kinds = events.map((event) =>
      event.type === "provider_subagent" ? event.event.type : event.type,
    );
    expect(kinds).toEqual([
      "remove", // close the tool-call-id descriptor
      "timeline",
      "timeline",
      "timeline",
      "upsert", // final descriptor under the run id
    ]);

    const finalUpsert = events.at(-1);
    expect(finalUpsert?.type).toBe("provider_subagent");
    if (finalUpsert?.type === "provider_subagent" && finalUpsert.event.type === "upsert") {
      expect(finalUpsert.event.id).toBe(RUN_ID);
      expect(finalUpsert.event.status).toBe("completed");
      expect(finalUpsert.event.title).toBe("explore");
    }

    const timelineIds = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
          event.type === "provider_subagent",
      )
      .filter((event) => event.event.type === "timeline")
      .map((event) => (event.event as { id: string }).id);
    expect(new Set(timelineIds)).toEqual(new Set([RUN_ID]));
  });

  test("end without child transcript falls back to inline output", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = await tracker.end(
      SUBAGENT_TOOL_CALL_ID,
      { output: "async run started", details: { results: [] } },
      false,
    );

    const timelineItems = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
          event.type === "provider_subagent" && event.event.type === "timeline",
      )
      .map((event) => (event.event as { item: { type: string; text?: string } }).item);
    expect(timelineItems).toEqual([{ type: "assistant_message", text: "async run started" }]);

    const finalUpsert = events.at(-1)!;
    if (finalUpsert.type === "provider_subagent" && finalUpsert.event.type === "upsert") {
      expect(finalUpsert.event.status).toBe("completed");
      expect(finalUpsert.event.id).toBe(SUBAGENT_TOOL_CALL_ID);
    }
  });

  test("end with isError marks the descriptor failed", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = await tracker.end(
      SUBAGENT_TOOL_CALL_ID,
      { content: [{ type: "text", text: "launch failed" }], details: { results: [] } },
      true,
    );
    const finalUpsert = events.at(-1)!;
    if (finalUpsert.type === "provider_subagent" && finalUpsert.event.type === "upsert") {
      expect(finalUpsert.event.status).toBe("failed");
    }
  });

  test("cancelAll finalizes running descriptors as canceled", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = tracker.cancelAll();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("provider_subagent");
    if (events[0]?.type === "provider_subagent" && events[0].event.type === "upsert") {
      expect(events[0].event.status).toBe("canceled");
      expect(events[0].event.id).toBe(SUBAGENT_TOOL_CALL_ID);
    }
    expect(tracker.cancelAll()).toEqual([]);
  });

  test("end ignores unknown tool calls", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    expect(await tracker.end(SUBAGENT_TOOL_CALL_ID, runDetails([]), false)).toEqual([]);
  });
});

describe("pi history subagent replay", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function parentMessages(sessionFile: string): PiAgentMessage[] {
    return [
      {
        role: "user",
        content: "run the explore agent",
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: SUBAGENT_TOOL_CALL_ID,
            name: "subagent",
            arguments: subagentArgs(),
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: SUBAGENT_TOOL_CALL_ID,
        toolName: "subagent",
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          runId: RUN_ID,
          results: [{ agent: "explore", exitCode: 0, sessionFile }],
        },
      },
    ] as PiAgentMessage[];
  }

  test("replays descriptors and child timeline rows from parent history", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, childSessionLines().join("\n"), "utf8");

    const events = await collect(streamPiHistory("pi", parentMessages(sessionFile)));
    const subagentEvents = events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
        event.type === "provider_subagent",
    );

    const ups = subagentEvents.filter((event) => event.event.type === "upsert");
    expect(ups).toHaveLength(2);
    const first = ups[0]!.event as { id: string; status: string; title: string };
    const last = ups[1]!.event as { id: string; status: string };
    expect(first.id).toBe(RUN_ID);
    expect(first.status).toBe("running");
    expect(first.title).toBe("explore");
    expect(last.status).toBe("completed");

    const timeline = subagentEvents.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(3);
    const itemTypes = timeline.map(
      (event) => (event.event as { item: { type: string } }).item.type,
    );
    expect(itemTypes).toEqual(["user_message", "reasoning", "assistant_message"]);
  });

  test("non-subagent history passes through without subagent events", async () => {
    const messages: PiAgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    const events = await collect(streamPiHistory("pi", messages));
    expect(events.every((event) => event.type !== "provider_subagent")).toBe(true);
  });

  test("subagent toolResult without run payload is skipped", async () => {
    const messages: PiAgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_x",
        toolName: "subagent",
        content: [{ type: "text", text: "no details" }],
      } as PiAgentMessage,
    ];
    const events = await collect(streamPiHistory("pi", messages));
    expect(events.every((event) => event.type !== "provider_subagent")).toBe(true);
  });

  test("failed result replay marks descriptor failed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "missing.jsonl"); // child file not written

    const messages: PiAgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: SUBAGENT_TOOL_CALL_ID,
            name: "subagent",
            arguments: subagentArgs(),
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: SUBAGENT_TOOL_CALL_ID,
        toolName: "subagent",
        content: [{ type: "text", text: "child crashed" }],
        isError: true,
        details: {
          mode: "single",
          results: [{ agent: "explore", exitCode: 1, error: "boom", sessionFile }],
        },
      } as PiAgentMessage,
    ];
    const events = await collect(streamPiHistory("pi", messages));
    const subagentEvents = events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
        event.type === "provider_subagent",
    );
    const lastUpsert = subagentEvents.findLast((event) => event.event.type === "upsert")!.event as {
      status: string;
    };
    expect(lastUpsert.status).toBe("failed");
    // Missing child file → inline fallback row from tool content.
    const timeline = subagentEvents.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(1);
    expect((timeline[0]!.event as { item: { text?: string } }).item.text).toBe("child crashed");
  });
});
