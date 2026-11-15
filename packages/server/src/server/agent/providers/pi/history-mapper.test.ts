import { buildAgentForkContextAttachment } from "../../activity-curator.js";
import { readPiTranscript } from "./transcript.js";
import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("renders visible custom messages as completed tools and hides private context", async () => {
    const events = await collectHistory([
      {
        role: "custom",
        customType: "project-context",
        content: "Project instructions",
        display: true,
      },
      {
        role: "custom",
        customType: "private-context",
        content: "Hidden instructions",
        display: false,
      },
      { role: "custom", customType: "project-context", content: "Project instructions" },
    ]);
    expect(events.map((event) => event.item)).toEqual(
      [1, 2].map((index) => ({
        type: "tool_call",
        callId: `pi-custom-${index}`,
        name: "project-context",
        status: "completed",
        detail: { type: "plain_text", text: "Project instructions" },
        metadata: { synthetic: true, customType: "project-context" },
        error: null,
      })),
    );
  });

  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "done", messageId: "response-1" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("replays custom messages as completed tools, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-custom-1",
          name: "custom-message",
          status: "completed",
          detail: { type: "plain_text", text: "Extension command output" },
          metadata: { synthetic: true, customType: "custom-message" },
          error: null,
        },
      },
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "first answer",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});

describe("Pi tool-result image replay", () => {
  test("recreates an image from native tool-result history without its source file", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "image-read",
            name: "read",
            arguments: { path: "missing-preview.png" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "image-read",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ]);
    expect(events.map((event) => event.item?.type)).toEqual([
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    const image = events.find(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );
    expect(image).toMatchObject({
      type: "timeline",
      item: { type: "assistant_message", text: expect.stringContaining("![Image](file://") },
    });
    if (image?.type !== "timeline" || image.item.type !== "assistant_message")
      throw new Error("Missing image");
    const url = image.item.text.match(/\((file:[^)]+)\)/)![1];
    const { readFile, unlink } = await import("node:fs/promises");
    expect(await readFile(new URL(url))).toEqual(Buffer.from("hello"));
    await unlink(new URL(url));
    const replay = await collectHistory([
      {
        role: "toolResult",
        toolCallId: "image-read",
        toolName: "read",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ]);
    expect(replay).toContainEqual(image);
    expect(await readFile(new URL(url))).toEqual(Buffer.from("hello"));
  });
});

test("replayed Pi images keep their position before the following reply", async () => {
  const events = await collectHistory([
    {
      role: "toolResult",
      toolCallId: "image-position",
      toolName: "read",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    },
    { role: "assistant", content: [{ type: "text", text: "Image read complete." }] },
  ]);
  expect(
    events.map((event) =>
      event.item?.type === "assistant_message" ? event.item.text : event.item?.type,
    ),
  ).toEqual(["tool_call", expect.stringContaining("![Image]("), "Image read complete."]);
});

test("replays both sides of compaction with native IDs and isolates rewound branches", async () => {
  const records = [
    { type: "session", version: 3, id: "session" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: "old question" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    },
    { type: "compaction", id: "c1", parentId: "a1", summary: "summary", firstKeptEntryId: "a1" },
    { type: "message", id: "u2", parentId: "c1", message: { role: "user", content: "follow up" } },
  ];
  const decode = (rows: unknown[]) =>
    readPiTranscript(rows.map((row) => JSON.stringify(row)).join("\n"));
  const history = decode(records);
  expect(history.userEntries.map((entry) => entry.id)).toEqual(["u1", "u2"]);
  expect(history.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  expect(await collectHistory(history.messages, history.userEntries)).toHaveLength(3);
  const rewound = [
    ...records,
    { type: "custom", id: "r1", parentId: null, customType: "paseo_rewind" },
  ];
  expect(decode(rewound).messages).toEqual([]);
  const replacement = [
    ...rewound,
    {
      type: "message",
      id: "u3",
      parentId: "r1",
      message: { role: "user", content: "replacement" },
    },
  ];
  expect(decode(replacement).userEntries.map((entry) => entry.id)).toEqual(["u3"]);
  expect(
    decode([
      ...replacement,
      { type: "custom", id: "r2", parentId: "a1", customType: "paseo_rewind" },
    ]).userEntries.map((entry) => entry.id),
  ).toEqual(["u1"]);
});

test("preserves native custom entries and legacy linear messages without inventing native IDs", async () => {
  const custom = {
    type: "custom_message",
    id: "custom",
    parentId: null,
    customType: "notice",
    content: "visible notice",
    display: true,
    details: { key: 1 },
  };
  const history = readPiTranscript(
    [JSON.stringify({ type: "session", version: 3 }), JSON.stringify(custom)].join("\n"),
  );
  expect(history.messages).toEqual([{ ...custom, role: "custom" }]);
  expect(await collectHistory(history.messages, history.userEntries)).toHaveLength(1);
  const legacy = readPiTranscript(
    '{"type":"session","version":1}\n{"type":"message","message":{"role":"user","content":"legacy"}}',
  );
  expect(legacy.messages).toEqual([{ role: "user", content: "legacy" }]);
  expect(legacy.userEntries).toEqual([]);
});

test.each([
  [{ type: "message", id: "x", parentId: "x", message: { role: "user", content: "cycle" } }],
  [{ type: "message", id: "x", parentId: "missing", message: { role: "user", content: "orphan" } }],
  [
    { type: "custom", id: "x", parentId: null },
    { type: "custom", id: "x", parentId: null },
  ],
  [{ type: "custom", id: "x" }],
])("rejects corrupt ancestry rather than replaying a plausible branch: %j", (...entries) => {
  expect(() =>
    readPiTranscript(
      [
        JSON.stringify({ type: "session", version: 3 }),
        ...entries.map((entry) => JSON.stringify(entry)),
      ].join("\n"),
    ),
  ).toThrow();
});

test("Fork chat stops at a restored pre-compaction reply on the active branch", async () => {
  const entries = [
    { type: "session", version: 3 },
    {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: "retained question" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "a1",
      message: { role: "user", content: "abandoned branch" },
    },
    { type: "compaction", id: "c1", parentId: "a1", summary: "summary" },
    {
      type: "message",
      id: "later",
      parentId: "c1",
      message: { role: "user", content: "later question" },
    },
  ];
  const transcript = readPiTranscript(entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const events = await collectHistory(transcript.messages, transcript.userEntries);
  const rows = events
    .filter((event) => event.type === "timeline")
    .map((event, index) => ({
      seq: index + 1,
      timestamp: "2026-10-31T00:00:00.000Z",
      item: event.item,
    }));
  const fork = buildAgentForkContextAttachment({
    rows,
    cursorBoundary: { cursor: { epoch: "test", seq: 2 }, timelineEpoch: "test" },
  });
  expect(fork.attachment.text).toContain("retained question");
  expect(fork.attachment.text).toContain("retained answer");
  expect(fork.attachment.text).not.toContain("abandoned branch");
  expect(fork.attachment.text).not.toContain("later question");
  expect(transcript.userEntries.map((entry) => entry.id)).toEqual(["u1", "later"]);
});

test("keeps reasoning, image content and tool results across structural entries", async () => {
  const messages: PiAgentMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "inspect" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "consider" },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "a.txt" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
    },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ];
  const records = [
    { type: "session", version: 3 },
    ...messages.map((message, index) => ({
      type: "message",
      id: String(index),
      parentId: index === 0 ? null : String(index - 1),
      message,
    })),
    { type: "compaction", id: "compact", parentId: "3", summary: "summary" },
  ];
  const history = readPiTranscript(records.map((record) => JSON.stringify(record)).join("\n"));
  expect(history.messages).toEqual(messages);
  expect(history.userEntries).toEqual([{ id: "0", text: "inspect" }]);
  expect(await collectHistory(history.messages, history.userEntries)).toEqual(
    await collectHistory(messages, [{ id: "0", text: "inspect" }]),
  );
});

test("traverses native system and summary messages without displaying private context", () => {
  const roles = [
    { role: "system", content: "private instructions" },
    { role: "user", content: "question" },
    { role: "branchSummary", summary: "branch context" },
    { role: "compactionSummary", summary: "compacted context" },
    { role: "system", content: null },
  ];
  const rows = [
    { type: "session", version: 3 },
    ...roles.map((message, index) => ({
      type: "message",
      id: String(index),
      parentId: index === 0 ? null : String(index - 1),
      message,
    })),
  ];
  expect(readPiTranscript(rows.map((row) => JSON.stringify(row)).join("\n"))).toEqual({
    messages: [{ role: "user", content: "question" }],
    userEntries: [{ id: "1", text: "question" }],
  });
});

test("restores surrounding chat when native system content uses text blocks", async () => {
  const records = [
    { type: "session", version: 3 },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "question" } },
    {
      type: "message",
      id: "s",
      parentId: "u",
      message: { role: "system", content: [{ type: "text", text: "private instructions" }] },
    },
    {
      type: "message",
      id: "a",
      parentId: "s",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    },
  ];
  const history = readPiTranscript(records.map((record) => JSON.stringify(record)).join("\n"));
  expect(history.messages).toEqual([
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ]);
  expect(history.userEntries).toEqual([{ id: "u", text: "question" }]);
  const events = await collectHistory(history.messages, history.userEntries);
  expect(events.map((event) => event.item)).toEqual([
    { type: "user_message", text: "question", messageId: "u" },
    { type: "assistant_message", text: "answer", messageId: "pi-history-assistant-1" },
  ]);
});
