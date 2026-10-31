import { describe, expect, it } from "vitest";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";

describe("desktop agent navigation", () => {
  it("finds an agent deep link among Electron launch arguments", () => {
    expect(
      parseAgentDeepLinkFromArgv([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://h/server-1/agent/agent-2",
      ]),
    ).toEqual({ serverId: "server-1", agentId: "agent-2" });
  });

  it("holds navigation until the existing renderer is ready", () => {
    const inbox = new AgentNavigationInbox();
    const target = { serverId: "server-1", agentId: "agent-2" };

    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("returns only the newest navigation queued during startup", () => {
    const inbox = new AgentNavigationInbox();

    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-1" });
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-2" });

    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "agent-2" });
    expect(inbox.windowReady(7)).toBeNull();
  });
});

describe("windowsShowingTarget", () => {
  const noUrl = () => null;

  it("tier 1: prefers the window already showing the agent", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: [], visibleWorkspaceKeys: [] });
    inbox.setWindowView(2, { visibleAgentIds: ["agent-1"], visibleWorkspaceKeys: [] });

    const result = inbox.windowsShowingTarget(
      [1, 2],
      { serverId: "server-1", workspaceId: null, agentId: "agent-1" },
      noUrl,
    );

    expect(result).toEqual([2]);
  });

  it("tier 2: matches on the window's current URL, ranked above the sidebar tier", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: [], visibleWorkspaceKeys: ["server-1:ws-1"] });
    inbox.setWindowView(2, { visibleAgentIds: [], visibleWorkspaceKeys: [] });
    const urls = new Map([[2, "paseo://app/h/server-1/workspace/ws-1"]]);

    const result = inbox.windowsShowingTarget(
      [1, 2],
      { serverId: "server-1", workspaceId: "ws-1", agentId: null },
      (id) => urls.get(id) ?? null,
    );

    expect(result).toEqual([2, 1]);
  });

  it("tier 3: falls back to the sidebar's visible workspace keys", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: [], visibleWorkspaceKeys: ["server-1:ws-1"] });

    const result = inbox.windowsShowingTarget(
      [1],
      { serverId: "server-1", workspaceId: "ws-1", agentId: null },
      noUrl,
    );

    expect(result).toEqual([1]);
  });

  it("breaks ties within a tier by most recently focused", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: [], visibleWorkspaceKeys: ["server-1:ws-1"] });
    inbox.setWindowView(2, { visibleAgentIds: [], visibleWorkspaceKeys: ["server-1:ws-1"] });
    inbox.noteWindowFocused(1);
    inbox.noteWindowFocused(2);

    const result = inbox.windowsShowingTarget(
      [1, 2],
      { serverId: "server-1", workspaceId: "ws-1", agentId: null },
      noUrl,
    );

    expect(result).toEqual([2, 1]);
  });

  it("returns an empty list when nothing matches", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: [], visibleWorkspaceKeys: [] });

    const result = inbox.windowsShowingTarget(
      [1],
      { serverId: "server-1", workspaceId: "ws-1", agentId: "agent-1" },
      noUrl,
    );

    expect(result).toEqual([]);
  });

  it("windowLoading clears the window's view so it stops matching", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: ["agent-1"], visibleWorkspaceKeys: [] });
    inbox.windowLoading(1);

    const result = inbox.windowsShowingTarget(
      [1],
      { serverId: "server-1", workspaceId: null, agentId: "agent-1" },
      noUrl,
    );

    expect(result).toEqual([]);
  });

  it("removeWindow clears the view and drops the window from focus order", () => {
    const inbox = new AgentNavigationInbox();
    inbox.setWindowView(1, { visibleAgentIds: ["agent-1"], visibleWorkspaceKeys: [] });
    inbox.noteWindowFocused(1);
    inbox.removeWindow(1);

    const result = inbox.windowsShowingTarget(
      [1],
      { serverId: "server-1", workspaceId: null, agentId: "agent-1" },
      noUrl,
    );

    expect(result).toEqual([]);
  });
});
