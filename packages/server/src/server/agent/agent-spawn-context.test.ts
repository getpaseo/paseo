import { describe, expect, it } from "vitest";

import {
  buildAgentMessageEnvelope,
  buildSpawnContextEnvelope,
  composeAgentMcpInstructions,
  prependSpawnContext,
  projectAgentMessageForDisplay,
} from "./agent-spawn-context.js";
import { displayTextForUserMessage, isSystemInjectedEnvelope } from "./agent-prompt.js";

describe("composeAgentMcpInstructions", () => {
  it("states the agent's own id and the parent report contract for a spawned child", () => {
    const instructions = composeAgentMcpInstructions({
      callerAgentId: "agent-child",
      parentAgentId: "agent-parent",
      parentTitle: "Ship the release",
    });

    expect(instructions).toContain("Your agentId is agent-child.");
    expect(instructions).toContain("spawned by agent agent-parent (Ship the release)");
    expect(instructions).toContain("AUTOMATICALLY delivered to that agent as your report");
    expect(instructions).toContain("<agent-response>");
    expect(instructions).toContain("do NOT need to copy any protocol block");
  });

  it("teaches the agent-to-agent message envelope and how to reply", () => {
    const instructions = composeAgentMcpInstructions({ callerAgentId: "agent-child" });

    expect(instructions).toContain("<paseo-agent-message");
    expect(instructions).toContain("was sent to you by another agent");
    expect(instructions).toContain("reply via send_agent_prompt to that id");
  });

  it("omits the parent report contract when the caller has no parent", () => {
    const instructions = composeAgentMcpInstructions({ callerAgentId: "agent-root" });

    expect(instructions).toContain("Your agentId is agent-root.");
    expect(instructions).not.toContain("spawned by agent");
    expect(instructions).not.toContain("delivered to that agent as your report");
    expect(instructions).toContain("When you spawn children with create_agent");
  });

  it("drops identity lines entirely for external clients with no caller agent", () => {
    const instructions = composeAgentMcpInstructions({});

    expect(instructions).not.toContain("Your agentId is");
    expect(instructions).not.toContain("spawned by agent");
    expect(instructions).toContain("You are connected to Paseo");
    expect(instructions).toContain("When you spawn children with create_agent");
  });

  it("falls back to the bare parent id when no title resolves", () => {
    const instructions = composeAgentMcpInstructions({
      callerAgentId: "agent-child",
      parentAgentId: "agent-parent",
      parentTitle: null,
    });

    expect(instructions).toContain("spawned by agent agent-parent.");
    expect(instructions).not.toContain("agent-parent (");
  });

  it("stays compact enough to live in a system prompt", () => {
    const instructions = composeAgentMcpInstructions({
      callerAgentId: "agent-child",
      parentAgentId: "agent-parent",
      parentTitle: "Ship the release",
    });

    expect(instructions.split(/\s+/).length).toBeLessThan(600);
  });
});

describe("buildSpawnContextEnvelope", () => {
  it("promises automatic report delivery when notifyOnFinish is set", () => {
    const envelope = buildSpawnContextEnvelope({
      childAgentId: "agent-child",
      parentAgentId: "agent-parent",
      parentTitle: "Ship the release",
      notifyOnFinish: true,
    });

    expect(isSystemInjectedEnvelope(envelope)).toBe(true);
    expect(envelope).toContain(
      "You are agent agent-child, spawned by agent agent-parent (Ship the release)",
    );
    expect(envelope).toContain("automatically delivered to agent agent-parent as your report");
  });

  it("states no automatic delivery when notifyOnFinish is unset", () => {
    const envelope = buildSpawnContextEnvelope({
      childAgentId: "agent-child",
      parentAgentId: "agent-parent",
      parentTitle: null,
      notifyOnFinish: false,
    });

    expect(isSystemInjectedEnvelope(envelope)).toBe(true);
    expect(envelope).toContain("not automatically delivered back");
    expect(envelope).toContain("agent agent-parent follows up if it needs your result");
  });
});

describe("prependSpawnContext", () => {
  const envelope = buildSpawnContextEnvelope({
    childAgentId: "agent-child",
    parentAgentId: "agent-parent",
    parentTitle: "Ship the release",
    notifyOnFinish: true,
  });

  it("prepends the envelope and a blank line to a string prompt", () => {
    const result = prependSpawnContext("Do the work", envelope);

    expect(result).toBe(`${envelope}\n\nDo the work`);
  });

  it("prepends a leading text block to a structured prompt", () => {
    const result = prependSpawnContext(
      [{ type: "image", data: "abc", mimeType: "image/png" }],
      envelope,
    );

    expect(result).toEqual([
      { type: "text", text: `${envelope}\n\n` },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
  });
});

describe("buildAgentMessageEnvelope", () => {
  it("wraps the prompt with sender identity and the auto-reply contract", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: "Ship the release",
      prompt: "Please review the auth changes.",
      autoReply: true,
    });

    expect(envelope).toBe(
      '<paseo-agent-message from="agent-a" from_title="Ship the release">\n' +
        "Please review the auth changes.\n" +
        "</paseo-agent-message>\n\n" +
        "When you finish this turn and go idle, your last assistant message is automatically delivered back to agent agent-a as your reply - make it complete and self-contained.",
    );
  });

  it("states manual reply when auto-delivery is off", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: null,
      prompt: "fyi",
      autoReply: false,
    });

    expect(envelope).toContain('<paseo-agent-message from="agent-a">\nfyi\n</paseo-agent-message>');
    expect(envelope).not.toContain("from_title=");
    expect(envelope).toContain(
      "Your reply is not automatically delivered; reach the sender via send_agent_prompt with agentId agent-a",
    );
  });

  it("is not a system envelope, so it is never hidden from the timeline", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: "Ship",
      prompt: "hi",
      autoReply: true,
    });

    expect(isSystemInjectedEnvelope(envelope)).toBe(false);
    // The timeline system-envelope projection leaves it intact for the sender
    // projection to handle.
    expect(displayTextForUserMessage(envelope)).toBe(envelope);
  });

  it("escapes XML-significant characters in the sender title", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: 'A & B <"tricky">',
      prompt: "hi",
      autoReply: true,
    });

    expect(envelope).toContain('from_title="A &amp; B &lt;&quot;tricky&quot;&gt;"');
    expect(projectAgentMessageForDisplay(envelope)).toContain(
      'Message from agent agent-a (A & B <"tricky">):',
    );
  });
});

describe("projectAgentMessageForDisplay", () => {
  it("rewrites a sender envelope to a readable header plus the original prompt", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: "Ship the release",
      prompt: "Please review the auth changes.",
      autoReply: true,
    });

    expect(projectAgentMessageForDisplay(envelope)).toBe(
      "Message from agent agent-a (Ship the release):\n\nPlease review the auth changes.",
    );
  });

  it("drops the trailing reply-contract boilerplate from the visible message", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: null,
      prompt: "Do the thing",
      autoReply: false,
    });

    const projected = projectAgentMessageForDisplay(envelope);
    expect(projected).toBe("Message from agent agent-a:\n\nDo the thing");
    expect(projected).not.toContain("send_agent_prompt");
  });

  it("preserves multi-paragraph prompts inside the envelope", () => {
    const envelope = buildAgentMessageEnvelope({
      senderAgentId: "agent-a",
      senderTitle: "Reviewer",
      prompt: "First line.\n\nSecond paragraph.",
      autoReply: true,
    });

    expect(projectAgentMessageForDisplay(envelope)).toBe(
      "Message from agent agent-a (Reviewer):\n\nFirst line.\n\nSecond paragraph.",
    );
  });

  it("returns plain text unchanged", () => {
    expect(projectAgentMessageForDisplay("just a normal prompt")).toBe("just a normal prompt");
  });
});
