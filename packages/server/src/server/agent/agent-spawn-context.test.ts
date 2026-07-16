import { describe, expect, it } from "vitest";

import {
  buildSpawnContextEnvelope,
  composeAgentMcpInstructions,
  prependSpawnContext,
} from "./agent-spawn-context.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";

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
