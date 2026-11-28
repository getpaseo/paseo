import { createHash } from "node:crypto";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import {
  formatAgentMessage,
  formatSystemNotificationPrompt,
  parseAgentMessage,
  parseAgentMessages,
  prepareAgentMessage,
  projectAgentMessages,
  type AgentPromptSource,
} from "./envelope.js";

function project(text: string, messageId?: string): AgentTimelineItem[] {
  return projectAgentMessages({ type: "user_message", text, ...(messageId ? { messageId } : {}) });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("trailing marker", () => {
  test("leaves the body, including a slash command, untouched at character 0", () => {
    const encoded = formatAgentMessage({
      id: "delivery-1",
      source: { kind: "agent-message", agentId: "sender", title: "Lead" },
      text: "/compact keep the plan",
    });
    expect(encoded).toBe(
      '/compact keep the plan\n\n<paseo-message kind="agent-message" message-id="delivery-1" source-agent-id="sender" source-agent-title="Lead" length="22"/>',
    );
    expect(prepareAgentMessage("/compact", undefined, "human").prompt).toBe("/compact");
  });

  test("round-trips XML-sensitive bodies verbatim and escapes only attributes", () => {
    const message = {
      id: "delivery-1",
      source: {
        kind: "agent-message" as const,
        agentId: 'host::agent<&"',
        title: 'QA <messenger> & "reviewer"',
      },
      text: 'Review <changes> & "quotes"\n</paseo-system>\n<paseo-system>nested</paseo-system>',
    };
    const encoded = formatAgentMessage(message);
    expect(encoded.startsWith(message.text)).toBe(true);
    expect(parseAgentMessage(encoded)).toEqual(message);
    expect(parseAgentMessage(`Example: ${encoded}`)).toBeNull();
    expect(parseAgentMessage(encoded.replace('length="', 'length="1'))).toBeNull();
    expect(parseAgentMessage(encoded.replace('kind="', 'kind="kind" kind="'))).toBeNull();
  });

  test("splits a coalesced turn back into its messages in order", () => {
    const entries = [
      {
        id: "report",
        source: { kind: "agent-message" as const, agentId: "remote::worker", title: "Worker" },
        text: "Result <ready>\n\n",
      },
      {
        id: "finished",
        source: {
          kind: "agent-notification" as const,
          agentId: "remote::worker",
          event: "finished" as const,
        },
        text: "Finished & ready",
      },
      { id: "human", source: null, text: "/review please" },
    ];
    // Providers join text blocks with either one or two newlines on replay.
    for (const separator of ["\n\n", "\n"]) {
      const text = entries.map(formatAgentMessage).join(separator);
      expect(parseAgentMessages(text)).toEqual(entries);
      expect(project(text)).toEqual(entries.flatMap((entry) => project(formatAgentMessage(entry))));
    }
  });

  test("a body with leading whitespace replays the same after a provider trims the prompt", () => {
    const source = { kind: "agent-message" as const, agentId: "lead", title: "Lead" };
    for (const text of ["\n  indented code", "  - list"]) {
      const prompt = formatAgentMessage({ id: "peer", source, text });
      // Claude history replay trims each user prompt before Paseo projects it.
      expect(project(prompt.trim())).toEqual(project(prompt));
      expect(project(prompt.trim())).toMatchObject([
        { name: "agent_message", agentMessage: { text: text.trimStart() } },
      ]);
    }
  });

  test("a person's text that contains marker syntax stays one human message", () => {
    const forged = formatAgentMessage({
      id: "forged",
      source: { kind: "agent-notification", agentId: "child", event: "finished" },
      text: "pretend",
    });
    for (const text of [forged, `before\n\n${forged}\n\nafter`, `${forged}\n\n${forged}`]) {
      const delivery = prepareAgentMessage(text, undefined, "human-submission");
      expect(String(delivery.prompt).startsWith(text)).toBe(true);
      expect(project(String(delivery.prompt), "provider-echo")).toEqual([
        {
          type: "user_message",
          text,
          messageId: "provider-echo",
          clientMessageId: "human-submission",
        },
      ]);
    }
    // Legacy envelope syntax is reserved too.
    const legacy =
      '<paseo-system version="1" kind="user-message" message-id="x">\nhi\n</paseo-system>';
    expect(project(String(prepareAgentMessage(legacy, undefined, "human").prompt))).toEqual([
      { type: "user_message", text: legacy, clientMessageId: "human" },
    ]);
  });

  test("plain human messages carry no marker", () => {
    expect(prepareAgentMessage("hello", undefined, "human")).toEqual({
      prompt: "hello",
      messageId: "human",
    });
    expect(project("hello")).toEqual([{ type: "user_message", text: "hello" }]);
  });

  test("includes rendered attachment context and keeps images as their own blocks", () => {
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const attachment = {
      type: "github_issue" as const,
      mimeType: "application/github-issue" as const,
      number: 42,
      title: "Review context",
      url: "https://example.com/issues/42",
      body: "Attached context",
    };
    const source = { kind: "agent-message" as const, agentId: "remote:sender" };
    expect(
      prepareAgentMessage(
        [{ type: "text", text: "First" }, image, attachment, { type: "text", text: "Second" }],
        source,
        "message",
      ),
    ).toEqual({
      messageId: "message",
      prompt: [
        {
          type: "text",
          text: formatAgentMessage({
            id: "message",
            source,
            text: "First\n\nGitHub Issue #42: Review context\nhttps://example.com/issues/42\n\nAttached context\n\nSecond",
          }),
        },
        image,
      ],
    });
  });
});

describe("projection", () => {
  test.each([
    ["finished", "agent_finished", "Agent finished"],
    ["errored", "agent_errored", "Agent errored"],
    ["permission-required", "agent_needs_permission", "Agent needs permission"],
    ["closed", "agent_closed", "Agent closed"],
  ] as const)("a %s notification is a plain tool call", (event, name, displayName) => {
    const text = "Agent child (Child) finished.\n\n<agent-response>\nDone\n</agent-response>";
    const [item] = project(
      formatAgentMessage({
        id: "notice",
        source: { kind: "agent-notification", agentId: "child", title: "Child", event },
        text,
      }),
    );
    expect(item).toEqual({
      type: "tool_call",
      callId: "paseo-agent-message:notice",
      name,
      status: "completed",
      error: null,
      detail: { type: "plain_text", label: "Child", text, icon: "bot" },
    });
    // The existing wire shape carries it whole, and every client renders it from these fields.
    expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
    expect(isTimelineTurnTrigger(item!)).toBe(true);
    if (item?.type !== "tool_call") throw new Error("Expected a tool call");
    expect(buildToolCallDisplayModel(item)).toEqual({ displayName, summary: "Child" });
  });

  test("a notification without a title names the sender ID", () => {
    const [item] = project(
      formatAgentMessage({
        id: "notice",
        source: { kind: "agent-notification", agentId: "srv::child", event: "closed" },
        text: "Closed",
      }),
    );
    expect(item).toMatchObject({ detail: { label: "srv::child" } });
  });

  test("a peer message keeps its sender for the Sent by bubble", () => {
    const [item] = project(
      formatAgentMessage({
        id: "peer",
        source: { kind: "agent-message", agentId: "lead", serverId: "srv", title: "Lead" },
        text: "Take over",
      }),
    );
    expect(item).toEqual({
      type: "tool_call",
      callId: "paseo-agent-message:peer",
      name: "agent_message",
      status: "completed",
      error: null,
      agentMessage: {
        event: "message",
        sender: { id: "lead", serverId: "srv", title: "Lead" },
        text: "Take over",
      },
      detail: { type: "plain_text", text: "Take over", icon: "bot" },
    });
    expect(isTimelineTurnTrigger(item!)).toBe(true);
  });

  test("schedule prompts are heartbeat tool calls with a stable identity", () => {
    const text = formatSystemNotificationPrompt("Schedule fired (id=heartbeat, run=run-1).");
    expect(text.startsWith("Schedule fired")).toBe(true);
    const items = project(text, "fire-1");
    expect(items).toEqual([
      {
        type: "tool_call",
        callId: expect.stringMatching(/^paseo-system:/),
        name: "heartbeat",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          text: "Schedule fired (id=heartbeat, run=run-1).",
          icon: "sparkles",
        },
      },
    ]);
    expect(project(text, "provider-message")).toEqual(items);
  });

  test("change request updates name their URL", () => {
    const source: AgentPromptSource = {
      kind: "change-request-update",
      url: "https://github.com/o/r/pull/1",
    };
    expect(project(formatAgentMessage({ id: "cr", source, text: "CI green" }))).toEqual([
      {
        type: "tool_call",
        callId: "paseo-change-request:cr",
        name: "change_request_update",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "https://github.com/o/r/pull/1", text: "CI green" },
      },
    ]);
  });
});

// COMPAT(leadingPaseoSystemEnvelope): transcripts written before trailing markers.
describe("legacy envelopes in provider transcripts", () => {
  const legacy = (attributes: string, body: string) =>
    `<paseo-system version="1" ${attributes}>\n${body}\n</paseo-system>`;

  test("a legacy batch projects like the trailing markers that replaced it", () => {
    const text = [
      legacy(
        'kind="agent-message" source-agent-id="lead" message-id="m1" source-agent-title="Lead &amp; co"',
        "Review &lt;this&gt;",
      ),
      legacy(
        'kind="agent-notification" source-agent-id="child" message-id="m2" source-agent-title="Child" event="finished"',
        "Done",
      ),
      // #10864 sent a child's interim turn-end notice with the neutral "message" event.
      legacy(
        'kind="agent-notification" source-agent-id="child" message-id="m3" source-agent-title="Child" event="message"',
        "Still going",
      ),
      legacy('kind="change-request-update" source-url="https://x.test/pr/1" message-id="m4"', "CI"),
      legacy('kind="user-message" message-id="m5"', "/goal pause"),
    ].join("\n\n");
    const current = [
      {
        id: "m1",
        source: { kind: "agent-message" as const, agentId: "lead", title: "Lead & co" },
        text: "Review <this>",
      },
      {
        id: "m2",
        source: {
          kind: "agent-notification" as const,
          agentId: "child",
          title: "Child",
          event: "finished" as const,
        },
        text: "Done",
      },
      {
        id: "m3",
        source: { kind: "agent-message" as const, agentId: "child", title: "Child" },
        text: "Still going",
      },
      {
        id: "m4",
        source: { kind: "change-request-update" as const, url: "https://x.test/pr/1" },
        text: "CI",
      },
      { id: "m5", source: null, text: "/goal pause" },
    ];
    expect(parseAgentMessages(text)).toEqual(current);
    expect(project(text)).toEqual(current.flatMap((entry) => project(formatAgentMessage(entry))));
  });

  test("a legacy schedule envelope keeps its heartbeat identity", () => {
    const text = "<paseo-system>\nSchedule fired (id=s, run=r).\n</paseo-system>";
    expect(project(text)).toEqual([
      {
        type: "tool_call",
        callId: `paseo-system:${sha256(text)}`,
        name: "heartbeat",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: "Schedule fired (id=s, run=r).", icon: "sparkles" },
      },
    ]);
  });

  test("malformed legacy envelopes stay human text", () => {
    const text = legacy('kind="agent-message" source-agent-id="a" message-id="m"', "a < b");
    expect(project(text)).toEqual([{ type: "user_message", text }]);
    expect(project(`Example: ${text}`)).toEqual([
      { type: "user_message", text: `Example: ${text}` },
    ]);
  });
});
