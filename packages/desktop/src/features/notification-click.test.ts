import { describe, expect, it } from "vitest";
import { chooseNotificationClickWindow, resolveNotificationRoute } from "./notification-click.js";

describe("resolveNotificationRoute", () => {
  it("resolves an agent target", () => {
    expect(
      resolveNotificationRoute({ serverId: "server-1", workspaceId: "ws-1", agentId: "agent-1" }),
    ).toEqual({ kind: "target", serverId: "server-1", workspaceId: "ws-1", agentId: "agent-1" });
  });

  it("resolves a workspace-only target", () => {
    expect(resolveNotificationRoute({ serverId: "server-1", workspaceId: "ws-1" })).toEqual({
      kind: "target",
      serverId: "server-1",
      workspaceId: "ws-1",
      agentId: null,
    });
  });

  it("falls back to the sender when there is no serverId", () => {
    expect(resolveNotificationRoute({ agentId: "agent-1" })).toEqual({ kind: "sender" });
    expect(resolveNotificationRoute({})).toEqual({ kind: "sender" });
    expect(resolveNotificationRoute(undefined)).toEqual({ kind: "sender" });
  });

  it("falls back to the sender for garbage field types", () => {
    expect(resolveNotificationRoute({ serverId: 42, workspaceId: "ws-1" } as never)).toEqual({
      kind: "sender",
    });
  });

  it("trims whitespace-only fields to null", () => {
    expect(resolveNotificationRoute({ serverId: "server-1", workspaceId: "   " })).toEqual({
      kind: "target",
      serverId: "server-1",
      workspaceId: null,
      agentId: null,
    });
  });
});

interface FakeWindow {
  id: string;
  focused: boolean;
  focus(): void;
}

function fakeWindow(id: string): FakeWindow {
  return {
    id,
    focused: false,
    focus() {
      this.focused = true;
    },
  };
}

describe("chooseNotificationClickWindow", () => {
  it("delivers to the sender when the route has no target", () => {
    const sender = fakeWindow("sender");
    const chosen = chooseNotificationClickWindow({
      route: { kind: "sender" },
      candidates: [fakeWindow("A")],
      sender,
    });
    expect(chosen).toBe(sender);
  });

  it("delivers to the best-ranked candidate, and focusing it is the caller's job", () => {
    const sender = fakeWindow("sender");
    const best = fakeWindow("B");
    const chosen = chooseNotificationClickWindow({
      route: { kind: "target", serverId: "server-1", workspaceId: "ws-1", agentId: null },
      candidates: [best, fakeWindow("A")],
      sender,
    });
    expect(chosen).toBe(best);
    expect(chosen?.focused).toBe(false);
    chosen?.focus();
    expect(chosen?.focused).toBe(true);
  });

  it("falls back to the sender when a target route has no candidates", () => {
    const sender = fakeWindow("sender");
    const chosen = chooseNotificationClickWindow({
      route: { kind: "target", serverId: "server-1", workspaceId: "ws-1", agentId: null },
      candidates: [],
      sender,
    });
    expect(chosen).toBe(sender);
  });

  it("returns null when there is no candidate and no sender", () => {
    const chosen = chooseNotificationClickWindow({
      route: { kind: "target", serverId: "server-1", workspaceId: "ws-1", agentId: null },
      candidates: [],
      sender: null,
    });
    expect(chosen).toBeNull();
  });
});
