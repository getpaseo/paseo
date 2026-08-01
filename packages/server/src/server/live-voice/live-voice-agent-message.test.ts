import { describe, expect, it } from "vitest";

import { formatLiveVoiceAgentNotification } from "./live-voice-agent-message.js";

describe("formatLiveVoiceAgentNotification", () => {
  it("names the work, where it ran, and what it reported", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Rebase main",
      reason: "finished",
      summary: "Rebased onto origin/main and pushed.",
      hostLabel: "Desktop",
    });

    expect(text).toContain('"Rebase main"');
    expect(text).toContain("on Desktop");
    expect(text).toContain("completed its current turn");
    expect(text).toContain("Rebased onto origin/main and pushed.");
    // The model is mid-call: this is an instruction to speak, not a line to read.
    expect(text).toContain("Tell the user now");
    expect(text).not.toContain("agent-1");
  });

  it("says a blocked session is waiting and offers to unblock it", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Deploy",
      reason: "needs_permission",
      summary: null,
    });

    expect(text).toContain("waiting for permission");
    expect(text).toContain("offer to answer it");
    expect(text).not.toContain("What it reported:");
  });

  it("passes through an outcome it does not recognize", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Deploy",
      reason: "vanished",
      summary: null,
    });

    expect(text).toContain("vanished");
  });

  describe("unsolicited work", () => {
    it("lets the model stay silent instead of ordering it to speak", () => {
      const text = formatLiveVoiceAgentNotification({
        agentId: "agent-9",
        title: "Nightly bump",
        reason: "turn_completed",
        summary: "Bumped 14 packages.",
        unsolicited: true,
      });

      expect(text).toContain("which you did not start");
      expect(text).toContain("silence is a valid response");
      // The user did not ask for this mid-conversation, so the note must not
      // read as an instruction to interrupt them.
      expect(text).not.toContain("Tell the user now");
    });

    it("still tells the model that work it did start is owed an answer", () => {
      const text = formatLiveVoiceAgentNotification({
        agentId: "agent-9",
        title: "Nightly bump",
        reason: "turn_completed",
        summary: "Bumped 14 packages.",
      });

      expect(text).toContain("which you started");
      expect(text).toContain("Tell the user now");
      expect(text).not.toContain("silence is a valid response");
    });

    it("marks a blocked session as more worth raising than a finished one", () => {
      const text = formatLiveVoiceAgentNotification({
        agentId: "agent-9",
        title: "Nightly bump",
        reason: "needs_permission",
        summary: null,
        unsolicited: true,
      });

      expect(text).toContain("stays blocked until someone answers");
    });
  });
});
