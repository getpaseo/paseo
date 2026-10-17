import imageHistory from "./fixtures/image-history.json" with { type: "json" };
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
          images: [{ data: "base64", mimeType: "image/png" }],
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

test("replays captured native Pi images without dropping the image-only entry", async () => {
  const entries = imageHistory.entries as Array<{ id: string; message: PiAgentMessage }>;
  const userEntries = entries.flatMap((entry) =>
    entry.message.role === "user" ? [{ id: entry.id, text: "" }] : [],
  );
  const history = await collectHistory(
    entries.map((entry) => entry.message),
    userEntries,
  );
  expect(
    history.flatMap((event) =>
      event.type === "timeline" && event.item.type === "user_message" ? [event.item] : [],
    ),
  ).toEqual(
    entries.flatMap((entry) =>
      entry.message.role === "user"
        ? [
            {
              type: "user_message",
              messageId: entry.id,
              text: Array.isArray(entry.message.content)
                ? entry.message.content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("\n\n")
                : entry.message.content,
              images: Array.isArray(entry.message.content)
                ? entry.message.content.flatMap((part) =>
                    part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : [],
                  )
                : [],
            },
          ]
        : [],
    ),
  );
});

test("replays only explicit captured client identities and preserves native entry ids", async () => {
  const userEntries = [
    { id: "native-image", text: "same", clientMessageId: "client-image" },
    { id: "native-external", text: "same" },
  ];
  const events = await collectHistory(
    [
      { role: "user", content: "same" },
      { role: "user", content: "same" },
    ],
    userEntries,
  );
  expect(events.map((event) => event.item)).toEqual([
    {
      type: "user_message",
      text: "same",
      messageId: "native-image",
      clientMessageId: "client-image",
    },
    { type: "user_message", text: "same", messageId: "native-external" },
  ]);
});

test("ignores empty user content without shifting later image identities", async () => {
  const events = await collectHistory(
    [
      { role: "user", content: [] },
      {
        role: "user",
        content: [
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "image", data: "AQ==", mimeType: "image/jpeg" },
        ],
      },
    ],
    [
      { id: "empty", text: "" },
      { id: "images", text: "" },
    ],
  );
  expect(events.map((event) => event.item)).toEqual([
    {
      type: "user_message",
      text: "",
      messageId: "images",
      images: [
        { data: "AA==", mimeType: "image/png" },
        { data: "AQ==", mimeType: "image/jpeg" },
      ],
    },
  ]);
});
