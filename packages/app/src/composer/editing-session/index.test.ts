import { describe, expect, it } from "vitest";
import { ComposerEditingSession, ComposerEditingSessions } from "./index";

describe("composer editing session", () => {
  it("publishes fullscreen changes once per transition", () => {
    const session = new ComposerEditingSession();
    const changes: boolean[] = [];
    session.subscribe(() => changes.push(session.getFullscreen()));
    session.setFullscreen(true);
    session.setFullscreen(true);
    session.setFullscreen(false);
    expect(changes).toEqual([true, false]);
  });

  it("hands the retained caret and focus intent to exactly one later mount", () => {
    const session = new ComposerEditingSession();
    expect(session.takeEditor()).toBeNull();
    session.retainEditor({ selection: { start: 4, end: 17 }, focused: true });
    expect(session.takeEditor()).toEqual({ selection: { start: 4, end: 17 }, focused: true });
    expect(session.takeEditor()).toBeNull();
  });
});

describe("composer editing sessions", () => {
  const workspace = "server:workspace";
  const target = JSON.stringify({ kind: "agent", agentId: "a" });

  it("keeps one session per tab and purpose until the tab target changes", () => {
    const sessions = new ComposerEditingSessions();
    const chat = sessions.get(workspace, "tab-1", target, "chat");
    expect(sessions.get(workspace, "tab-1", target, "chat")).toBe(chat);
    expect(sessions.get(workspace, "tab-1", target, "terminal")).not.toBe(chat);
    const retargeted = JSON.stringify({ kind: "agent", agentId: "b" });
    expect(sessions.get(workspace, "tab-1", retargeted, "chat")).not.toBe(chat);
  });

  it("reports a tab as fullscreen while any of its composers is fullscreen", () => {
    const sessions = new ComposerEditingSessions();
    const notifications: boolean[] = [];
    sessions.subscribe(() => notifications.push(sessions.isTabFullscreen(workspace, "tab-1")));
    const chat = sessions.get(workspace, "tab-1", target, "chat");
    sessions.get(workspace, "tab-2", target, "chat").setFullscreen(true);
    expect(sessions.isTabFullscreen(workspace, "tab-1")).toBe(false);
    expect(sessions.isTabFullscreen(workspace, null)).toBe(false);
    chat.setFullscreen(true);
    expect(sessions.isTabFullscreen(workspace, "tab-1")).toBe(true);
    chat.setFullscreen(false);
    expect(notifications).toEqual([false, true, false]);
  });

  it("drops sessions for closed tabs and keeps retained ones", () => {
    const sessions = new ComposerEditingSessions();
    const kept = sessions.get(workspace, "tab-1", target, "chat");
    kept.setFullscreen(true);
    sessions.get(workspace, "tab-2", target, "chat").setFullscreen(true);
    sessions.retain(workspace, ["tab-1"]);
    expect(sessions.get(workspace, "tab-1", target, "chat")).toBe(kept);
    expect(sessions.isTabFullscreen(workspace, "tab-2")).toBe(false);
    expect(sessions.get(workspace, "tab-2", target, "chat").getFullscreen()).toBe(false);
  });
});
