import { beforeEach, describe, expect, it } from "vitest";
import { useRecentlyClosedTabsStore } from "./recently-closed-tabs-store";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";

describe("recently closed tabs", () => {
  beforeEach(() => useRecentlyClosedTabsStore.setState({ byWorkspace: {} }));

  it("keeps what each workspace closed, newest first, once per tab", () => {
    const { record } = useRecentlyClosedTabsStore.getState();
    record("srv:wks_a", { kind: "agent", agentId: "a1" });
    record("srv:wks_a", { kind: "terminal", terminalId: "t1" });
    record("srv:wks_a", { kind: "agent", agentId: "a1" });
    record("srv:wks_b", { kind: "agent", agentId: "b1" });
    record("srv:wks_a", { kind: "files" });
    const closedInA = useRecentlyClosedTabsStore.getState().byWorkspace["srv:wks_a"] ?? [];
    expect(closedInA.map((entry) => entry.target)).toEqual([
      { kind: "agent", agentId: "a1" },
      { kind: "terminal", terminalId: "t1" },
    ]);
    expect(useRecentlyClosedTabsStore.getState().byWorkspace["srv:wks_b"]).toHaveLength(1);
  });

  it("remembers a browser tab's page, since the tab itself is gone", () => {
    const { browserId } = createWorkspaceBrowser({ initialUrl: "https://example.org/docs" });
    useBrowserStore.getState().removeBrowser(browserId);
    useRecentlyClosedTabsStore.getState().record("srv:wks_a", { kind: "browser", browserId });
    expect(useRecentlyClosedTabsStore.getState().byWorkspace["srv:wks_a"]?.[0]?.url).toBe(
      "https://example.org/docs",
    );
  });

  it("keeps a session's title, since closing archives it out of the live list", () => {
    const sessions = useSessionStore.getState().sessions;
    useSessionStore.setState({
      sessions: {
        ...sessions,
        srv: { ...sessions.srv, agents: new Map([["a9", { id: "a9", title: "Fix login" }]]) },
      } as never,
    });
    useRecentlyClosedTabsStore.getState().record("srv:wks_a", { kind: "agent", agentId: "a9" });
    expect(useRecentlyClosedTabsStore.getState().byWorkspace["srv:wks_a"]?.[0]?.title).toBe(
      "Fix login",
    );
  });
});
