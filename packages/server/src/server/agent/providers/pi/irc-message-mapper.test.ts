import { describe, expect, test } from "vitest";

import { mapPiIrcMessage, parsePiIrcEnvelope } from "./irc-message-mapper.js";

const currentEnvelope = `<irc>
Incoming IRC message from agent \`AgentMessageUi\` (reply to msg-42):

First line
second line

Sent while waiting/working. Active interruptible wait stopped early for immediate reading.

If response expected, reply via hub.
</irc>`;

const historicalEnvelope = `<irc>
Incoming IRC message from agent Main:

Historical message

An agent sent this while you were waiting or working. Read it before continuing.
</irc>`;

describe("Pi IRC message mapper", () => {
  test("parses current and historical textual envelopes", () => {
    expect(parsePiIrcEnvelope(currentEnvelope)).toEqual({
      sender: "AgentMessageUi",
      text: "First line\nsecond line",
    });
    expect(
      mapPiIrcMessage(
        { role: "custom", customType: "irc:incoming", content: currentEnvelope },
        currentEnvelope,
      ),
    ).toEqual({
      type: "tool_call",
      callId: expect.stringMatching(/^pi-irc:[0-9a-f]{64}$/),
      name: "agent_message",
      status: "completed",
      detail: {
        type: "sub_agent",
        subAgentType: "AgentMessageUi",
        description: "First line\nsecond line",
        log: currentEnvelope,
      },
      error: null,
    });
    expect(parsePiIrcEnvelope(historicalEnvelope)).toEqual({
      sender: "Main",
      text: "Historical message",
    });
  });

  test("prefers structured details without interpreting message text as transport metadata", () => {
    expect(
      mapPiIrcMessage(
        {
          role: "custom",
          customType: "irc:incoming",
          content: currentEnvelope,
          details: {
            id: "msg-42",
            from: "Main",
            message: "Keep this line\n\nSent while waiting/working. This is message content.",
          },
        },
        currentEnvelope,
      ),
    ).toEqual({
      type: "tool_call",
      callId: "pi-irc:msg-42",
      name: "agent_message",
      status: "completed",
      detail: {
        type: "sub_agent",
        subAgentType: "Main",
        description: "Keep this line\n\nSent while waiting/working. This is message content.",
        log: currentEnvelope,
      },
      error: null,
    });
  });

  test("rejects other custom types and malformed IRC envelopes", () => {
    expect(
      mapPiIrcMessage(
        { role: "custom", customType: "other", content: currentEnvelope },
        currentEnvelope,
      ),
    ).toBeNull();
    expect(
      mapPiIrcMessage(
        {
          role: "custom",
          customType: "irc:incoming",
          content: "Incoming IRC message without an envelope",
        },
        "Incoming IRC message without an envelope",
      ),
    ).toBeNull();
    expect(
      parsePiIrcEnvelope("<irc>\nIncoming IRC message from agent ``:\n\ntext\n</irc>"),
    ).toBeNull();
  });
});
