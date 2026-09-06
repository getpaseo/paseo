import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";

type ProviderSubagentStreamEvent = Extract<AgentStreamEvent, { type: "provider_subagent" }>;
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

function subagentEvents(events: AgentStreamEvent[]): ProviderSubagentStreamEvent[] {
  return events.filter(
    (event): event is ProviderSubagentStreamEvent => event.type === "provider_subagent",
  );
}

function expectUpsert(event: ProviderSubagentStreamEvent): {
  id: string;
  title: string;
  description: string | null;
  status: string;
  toolCallId: string;
  subtitle?: string;
} {
  expect(event.event.type).toBe("upsert");
  if (event.event.type !== "upsert") {
    throw new Error("expected upsert event");
  }
  return event.event;
}

function expectTimeline(event: ProviderSubagentStreamEvent): {
  id: string;
  item: { type: string; text?: string };
} {
  expect(event.event.type).toBe("timeline");
  if (event.event.type !== "timeline") {
    throw new Error("expected timeline event");
  }
  return event.event as { id: string; item: { type: string; text?: string } };
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
    const events = subagentEvents(
      tracker.update(
        SUBAGENT_TOOL_CALL_ID,
        runDetails([{ progress: { activityState: "reading", model: "nous_portal/ox-alpha" } }]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(expectUpsert(events[0]!).subtitle).toBe("reading · ox-alpha");
  });

  test("update without new presentation emits nothing", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    expect(
      subagentEvents(
        tracker.update(
          SUBAGENT_TOOL_CALL_ID,
          runDetails([{ progress: { activityState: "reading" } }]),
        ),
      ),
    ).toHaveLength(1);
    expect(
      tracker.update(
        SUBAGENT_TOOL_CALL_ID,
        runDetails([{ progress: { activityState: "reading" } }]),
      ),
    ).toEqual([]);
  });

  test("end re-keys descriptor to run id with a running upsert before timeline rows", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, childSessionLines().join("\n"), "utf8");

    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = subagentEvents(
      (await tracker.end(
        SUBAGENT_TOOL_CALL_ID,
        runDetails([{ agent: "explore", exitCode: 0, sessionFile }]),
        false,
      )) ?? [],
    );

    const kinds = events.map((event) => event.event.type);
    expect(kinds).toEqual([
      "remove", // close the tool-call-id descriptor
      "upsert", // open the run-id descriptor before rows stream
      "timeline",
      "timeline",
      "timeline",
      "upsert", // final descriptor under the run id
    ]);

    const reopened = expectUpsert(events[1]!);
    expect(reopened.id).toBe(RUN_ID);
    expect(reopened.status).toBe("running");
    // The host tool-call id survives the re-key so the UI can correlate the
    // descriptor with the parent transcript.
    expect(reopened.toolCallId).toBe(SUBAGENT_TOOL_CALL_ID);

    const finalUpsert = expectUpsert(events[5]!);
    expect(finalUpsert.id).toBe(RUN_ID);
    expect(finalUpsert.status).toBe("completed");
    expect(finalUpsert.title).toBe("explore");
    expect(finalUpsert.toolCallId).toBe(SUBAGENT_TOOL_CALL_ID);

    for (const event of events.slice(2, 5)) {
      expect(expectTimeline(event).id).toBe(RUN_ID);
    }
  });

  test("end without child transcript falls back to inline output", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = subagentEvents(
      (await tracker.end(
        SUBAGENT_TOOL_CALL_ID,
        { output: "async run started", details: { results: [] } },
        false,
      )) ?? [],
    );

    const timeline = events.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(1);
    expect(expectTimeline(timeline[0]!).item).toEqual({
      type: "assistant_message",
      text: "async run started",
    });
    expect(expectTimeline(timeline[0]!).id).toBe(SUBAGENT_TOOL_CALL_ID);

    expect(expectUpsert(events.at(-1)!).status).toBe("completed");
    expect(expectUpsert(events.at(-1)!).id).toBe(SUBAGENT_TOOL_CALL_ID);
  });

  test("end marks failed when isError is set even with a successful payload", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = subagentEvents(
      (await tracker.end(
        SUBAGENT_TOOL_CALL_ID,
        { content: [{ type: "text", text: "launch failed" }], details: { results: [] } },
        true,
      )) ?? [],
    );
    expect(expectUpsert(events.at(-1)!).status).toBe("failed");
  });

  test("end marks failed when the run payload reports a child failure", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, childSessionLines().join("\n"), "utf8");

    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = subagentEvents(
      (await tracker.end(
        SUBAGENT_TOOL_CALL_ID,
        runDetails([{ agent: "explore", exitCode: 1, error: "boom", sessionFile }]),
        false,
      )) ?? [],
    );
    expect(expectUpsert(events.at(-1)!).status).toBe("failed");
  });

  test("cancelAll finalizes running descriptors as canceled", () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const events = subagentEvents(tracker.cancelAll());
    expect(events).toHaveLength(1);
    expect(expectUpsert(events[0]!).status).toBe("canceled");
    expect(expectUpsert(events[0]!).id).toBe(SUBAGENT_TOOL_CALL_ID);
    expect(tracker.cancelAll()).toEqual([]);
  });

  test("end after cancelAll is stale and emits nothing", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    tracker.cancelAll();
    const result = await tracker.end(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ agent: "explore", exitCode: 0 }]),
      false,
    );
    expect(result).toBeNull();
  });

  test("cancelAll during transcript read drops the late finalization", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, childSessionLines().join("\n"), "utf8");

    const tracker = new PiSubagentTracker(noopLogger);
    tracker.start(SUBAGENT_TOOL_CALL_ID, subagentArgs());
    const endPromise = tracker.end(
      SUBAGENT_TOOL_CALL_ID,
      runDetails([{ agent: "explore", exitCode: 0, sessionFile }]),
      false,
    );
    // Cancel while end() is awaiting the child transcript read.
    const cancelEvents = subagentEvents(tracker.cancelAll());
    expect(cancelEvents).toHaveLength(1);
    expect(expectUpsert(cancelEvents[0]!).status).toBe("canceled");
    expect(expectUpsert(cancelEvents[0]!).id).toBe(SUBAGENT_TOOL_CALL_ID);

    // The in-flight end must not resurrect the run as completed.
    expect(await endPromise).toBeNull();
  });

  test("end ignores unknown tool calls", async () => {
    const tracker = new PiSubagentTracker(noopLogger);
    expect(await tracker.end(SUBAGENT_TOOL_CALL_ID, runDetails([]), false)).toBeNull();
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

    const events = subagentEvents(
      await collect(streamPiHistory("pi", parentMessages(sessionFile))),
    );
    const ups = events.filter((event) => event.event.type === "upsert");
    expect(ups).toHaveLength(2);
    const first = expectUpsert(ups[0]!);
    const last = expectUpsert(ups[1]!);
    expect(first.id).toBe(RUN_ID);
    expect(first.status).toBe("running");
    expect(first.title).toBe("explore");
    expect(last.status).toBe("completed");

    const timeline = events.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(3);
    const itemTypes = timeline.map((event) => expectTimeline(event).item.type);
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

  test("subagent toolResult without run payload still surfaces a descriptor", async () => {
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
        content: [{ type: "text", text: "details were stripped" }],
      } as PiAgentMessage,
    ];
    const events = subagentEvents(await collect(streamPiHistory("pi", messages)));
    const ups = events.filter((event) => event.event.type === "upsert");
    expect(ups).toHaveLength(2);
    expect(expectUpsert(ups[0]!).status).toBe("running");
    expect(expectUpsert(ups[0]!).id).toBe(SUBAGENT_TOOL_CALL_ID);
    expect(expectUpsert(ups[1]!).status).toBe("completed");
    const timeline = events.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(1);
    expect(expectTimeline(timeline[0]!).item.text).toBe("details were stripped");
  });

  test("subagent toolResult with no recoverable output is skipped", async () => {
    const messages: PiAgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_x",
        toolName: "subagent",
        content: [],
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
    const events = subagentEvents(await collect(streamPiHistory("pi", messages)));
    const lastUpsert = expectUpsert(events.findLast((event) => event.event.type === "upsert")!);
    expect(lastUpsert.status).toBe("failed");
    // Missing child file → inline fallback row from tool content.
    const timeline = events.filter((event) => event.event.type === "timeline");
    expect(timeline).toHaveLength(1);
    expect(expectTimeline(timeline[0]!).item.text).toBe("child crashed");
  });

  test("child session read errors are reported to the replay error hook", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "paseo-pi-subagent-"));
    // A directory instead of a file: reading it throws a non-ENOENT error.
    const sessionFile = join(tempDir, "session-dir");
    rmSync(sessionFile, { force: true });
    writeFileSync(join(tempDir, "placeholder"), "", "utf8");
    rmSync(join(tempDir, "placeholder"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sessionFile);

    const messages: PiAgentMessage[] = [
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
      } as PiAgentMessage,
    ];

    const replayErrors: string[] = [];
    const events = subagentEvents(
      await collect(
        streamPiHistory("pi", messages, [], {
          onSubagentReplayError: (error, file) => {
            replayErrors.push(`${file}: ${(error as Error).message}`);
          },
        }),
      ),
    );
    expect(replayErrors).toHaveLength(1);
    expect(replayErrors[0]).toContain(sessionFile);
    // The replay still completes with descriptors and the inline fallback row.
    expect(events.filter((event) => event.event.type === "upsert")).toHaveLength(2);
    expect(events.filter((event) => event.event.type === "timeline")).toHaveLength(1);
  });
});
