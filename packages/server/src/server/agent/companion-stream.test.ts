import { describe, expect, it } from "vitest";
import type { CompanionEntry } from "@getpaseo/protocol/companion-stream";
import {
  CompanionStreamCollector,
  restoreCompanionEntries,
  COMPANION_ENTRY_LIMIT,
  COMPANION_TEXT_LIMIT,
} from "./companion-stream.js";

describe("conversation companion stream", () => {
  it("keeps a question open until the provider resolves its permission request", () => {
    const collector = new CompanionStreamCollector();
    const timestamp = "2026-09-21T12:00:00.000Z";
    const pending = collector.observe(
      "agent",
      [],
      {
        type: "permission_requested",
        provider: "codex",
        request: {
          id: "q1",
          provider: "codex",
          name: "request_user_input",
          kind: "question",
          input: { questions: [{ question: "Which database should we use?" }] },
        },
      },
      timestamp,
    );
    expect(pending).toEqual([
      {
        id: "permission:q1",
        kind: "permission",
        requestId: "q1",
        requestKind: "question",
        text: "Which database should we use?",
        timestamp,
        status: "pending",
        truncated: false,
      },
    ]);
    expect(
      collector.observe(
        "agent",
        pending,
        {
          type: "permission_resolved",
          provider: "codex",
          requestId: "q1",
          resolution: { behavior: "allow" },
        },
        timestamp,
      ),
    ).toEqual([{ ...pending[0], status: "allowed" }]);
  });
});

const timestamp = "2026-09-21T12:00:00.000Z";

it("collects only the final response, merges chunks, and keeps other agents separate", () => {
  const collector = new CompanionStreamCollector();
  const output = (agentId: string, text: string) =>
    collector.observe(
      agentId,
      [],
      {
        type: "timeline",
        provider: "codex",
        turnId: "run",
        item: { type: "assistant_message", text },
      },
      timestamp,
    );
  expect(output("one", "I will inspect the files")).toEqual([]);
  collector.observe(
    "one",
    [],
    {
      type: "timeline",
      provider: "codex",
      turnId: "run",
      item: {
        type: "tool_call",
        callId: "read",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "README.md" },
      },
    },
    timestamp,
  );
  output("one", "Implemented ");
  output("two", "Unrelated result");
  output("one", "the feature.");
  const result = collector.observe(
    "one",
    [],
    { type: "turn_completed", provider: "codex", turnId: "run" },
    timestamp,
  );
  expect(result).toEqual([
    {
      id: "turn:run",
      kind: "outcome",
      timestamp,
      text: "Implemented the feature.",
      truncated: false,
      status: "completed",
    },
  ]);
  expect(
    collector.observe(
      "one",
      result,
      { type: "turn_completed", provider: "codex", turnId: "run" },
      timestamp,
    ),
  ).toEqual(result);
});

it("tracks prose questions without claiming a reply resolved a decision", () => {
  const collector = new CompanionStreamCollector();
  collector.observe(
    "a",
    [],
    {
      type: "timeline",
      provider: "codex",
      turnId: "q",
      item: { type: "assistant_message", text: "Use SQLite or Postgres?" },
    },
    timestamp,
  );
  const result = collector.observe(
    "a",
    [],
    { type: "turn_completed", provider: "codex", turnId: "q" },
    timestamp,
  );
  expect(result).toEqual([
    {
      id: "turn:q:question",
      kind: "question",
      timestamp,
      text: "Use SQLite or Postgres?",
      truncated: false,
      status: "open",
    },
    { id: "turn:q", kind: "outcome", timestamp, text: "", truncated: false, status: "completed" },
  ]);
  expect(
    collector.observe(
      "a",
      result,
      {
        type: "timeline",
        provider: "codex",
        item: { type: "user_message", text: "What do you recommend?" },
      },
      timestamp,
    ),
  ).toEqual([{ ...result[0], status: "reply_sent" }, result[1]]);
});

it.each(["Example: `ready?`", "Example:\n```js\nready?\n```", "See https://example.com/?"])(
  "does not turn code or URLs into open questions: %s",
  (text) => {
    const collector = new CompanionStreamCollector();
    collector.observe(
      "a",
      [],
      {
        type: "timeline",
        provider: "codex",
        turnId: "r",
        item: { type: "assistant_message", text },
      },
      timestamp,
    );
    expect(
      collector
        .observe("a", [], { type: "turn_completed", provider: "codex", turnId: "r" }, timestamp)
        .map((entry) => entry.kind),
    ).toEqual(["outcome"]);
  },
);

it("retains structured questions after unrelated user messages and expires them on interruption", () => {
  const collector = new CompanionStreamCollector();
  const entries = collector.observe(
    "a",
    [],
    {
      type: "permission_requested",
      provider: "codex",
      request: {
        id: "p",
        name: "approval",
        kind: "plan",
        provider: "codex",
        detail: { type: "plan", text: "Migrate the database" },
      },
    },
    timestamp,
  );
  expect(
    collector.observe(
      "a",
      entries,
      { type: "timeline", provider: "codex", item: { type: "user_message", text: "Wait" } },
      timestamp,
    ),
  ).toEqual(entries);
  expect(
    collector.observe(
      "a",
      entries,
      { type: "turn_canceled", provider: "codex", turnId: "r", reason: "Stopped by user" },
      timestamp,
    ),
  ).toEqual([
    { ...entries[0], status: "expired" },
    {
      id: "turn:r",
      kind: "outcome",
      timestamp,
      text: "Stopped by user",
      truncated: false,
      status: "canceled",
    },
  ]);
  expect(restoreCompanionEntries({ companionEntries: entries })).toEqual([
    { ...entries[0], status: "expired" },
  ]);
});

it("bounds stored output and records failure independently of an assistant success claim", () => {
  const collector = new CompanionStreamCollector();
  collector.observe(
    "a",
    [],
    {
      type: "timeline",
      provider: "codex",
      turnId: "r",
      item: { type: "assistant_message", text: "Succeeded!" },
    },
    timestamp,
  );
  const error = "x".repeat(COMPANION_TEXT_LIMIT + 100);
  expect(
    collector.observe(
      "a",
      [],
      { type: "turn_failed", provider: "codex", turnId: "r", error },
      timestamp,
    ),
  ).toEqual([
    {
      id: "turn:r",
      kind: "outcome",
      timestamp,
      text: error.slice(0, COMPANION_TEXT_LIMIT),
      truncated: true,
      status: "failed",
    },
  ]);
  let entries: CompanionEntry[] = [];
  for (let i = 0; i < COMPANION_ENTRY_LIMIT + 2; i++) {
    entries = collector.observe(
      "a",
      entries,
      { type: "turn_completed", provider: "codex", turnId: String(i) },
      timestamp,
    );
  }
  expect(entries.map((entry) => entry.id)).toEqual(
    Array.from({ length: COMPANION_ENTRY_LIMIT }, (_, i) => `turn:${i + 2}`),
  );
});
