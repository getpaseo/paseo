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

  it("places the work in its workspace and project", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Rebase main",
      reason: "finished",
      summary: "Rebased onto origin/main and pushed.",
      workspaceName: "Refresh Paseo assembly",
      projectName: "Paseo",
    });

    expect(text).toContain(
      'The "Rebase main" agent in the Refresh Paseo assembly workspace of the Paseo project',
    );
    // Which of those names to say is the model's call, not this note's.
    expect(text).toContain("Say which work this was before what happened to it");
    expect(text).toContain("often the project alone is clear enough");
  });

  it("says a name once when the workspace and agent are named after the same work", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Refresh Paseo assembly",
      reason: "finished",
      summary: null,
      workspaceName: "refresh-paseo-assembly",
      projectName: "Paseo",
    });

    expect(text.split("\n")[0]).toBe(
      'The "Refresh Paseo assembly" agent in the Paseo project completed its current turn.',
    );
  });

  it("keeps a project name that repeats a one-word workspace name", () => {
    const text = formatLiveVoiceAgentNotification({
      agentId: "agent-1",
      title: "Add paseo docs",
      reason: "finished",
      summary: null,
      workspaceName: "docs",
      projectName: "Paseo",
    });

    expect(text).toContain("in the docs workspace of the Paseo project");
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

      expect(text).toContain("Decide whether this is worth interrupting for");
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
