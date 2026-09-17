import { describe, expect, it } from "vitest";
import { ResponseControlSessions } from "./session.js";

const footer = '<paseo-meta message="Done." title="Tests" icon="🧪" />';
function text(sessions: ResponseControlSessions, content: string, turnId = "turn") {
  sessions.observe(
    "agent",
    {
      type: "timeline",
      provider: "codex",
      turnId,
      item: { type: "assistant_message", text: content },
    },
    turnId,
  );
}

describe("response control sessions", () => {
  it("ignores stale failures while the current response is accumulating", () => {
    const sessions = new ResponseControlSessions();
    sessions.open("agent", true);
    text(sessions, footer);
    sessions.observe(
      "agent",
      { type: "turn_failed", provider: "codex", error: "Old failure" },
      "old-turn",
    );
    expect(sessions.complete("agent", "turn")?.message).toBe("Done.");
  });
  it("consumes metadata once, only for the matching turn", () => {
    const sessions = new ResponseControlSessions();
    sessions.open("agent", true);
    text(sessions, footer);
    expect(sessions.complete("agent", "other")).toBeNull();
    text(sessions, footer);
    expect(sessions.complete("agent", "turn")?.message).toBe("Done.");
    expect(sessions.complete("agent", "turn")).toBeNull();
  });
  it.each(["turn_failed", "turn_canceled", "turn_started"] as const)(
    "discards summaries on %s",
    (type) => {
      const sessions = new ResponseControlSessions();
      sessions.open("agent", true);
      text(sessions, footer);
      if (type === "turn_failed")
        sessions.observe("agent", { type, provider: "codex", error: "Failed" }, "turn");
      else sessions.observe("agent", { type, provider: "codex" }, "turn");
      expect(sessions.complete("agent", "turn")).toBeNull();
    },
  );
  it("does not use intermediate responses or summaries from earlier turns", () => {
    const sessions = new ResponseControlSessions();
    sessions.open("agent", true);
    text(sessions, footer);
    sessions.observe(
      "agent",
      { type: "timeline", provider: "codex", item: { type: "user_message", text: "Next" } },
      "turn",
    );
    text(sessions, "Final answer without metadata.");
    expect(sessions.complete("agent", "turn")).toBeNull();
    text(sessions, footer, "first");
    text(sessions, "New turn.", "second");
    expect(sessions.complete("agent", "second")).toBeNull();
  });
  it("only changes enablement when opening a session", () => {
    const sessions = new ResponseControlSessions();
    sessions.open("agent", false);
    text(sessions, footer);
    expect(sessions.complete("agent", "turn")).toBeNull();
    sessions.open("agent", true);
    text(sessions, footer);
    expect(sessions.complete("agent", "turn")?.title).toBe("Tests");
    sessions.close("agent");
    text(sessions, footer);
    expect(sessions.complete("agent", "turn")).toBeNull();
  });
});
