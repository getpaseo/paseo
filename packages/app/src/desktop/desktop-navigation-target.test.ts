import { describe, expect, it } from "vitest";
import { buildHostWorkspaceRoute, encodeWorkspaceIdForPathSegment } from "@/utils/host-routes";
import { readDesktopNavigationTarget } from "./desktop-navigation-target";

describe("readDesktopNavigationTarget", () => {
  it("reads an agent target", () => {
    expect(readDesktopNavigationTarget({ serverId: "srv", agentId: "agent-1" })).toEqual({
      kind: "agent",
      serverId: "srv",
      agentId: "agent-1",
    });
  });

  it("reads a terminal target", () => {
    expect(
      readDesktopNavigationTarget({ serverId: "srv", workspaceId: "wks_1", terminalId: "term-1" }),
    ).toEqual({ kind: "terminal", serverId: "srv", workspaceId: "wks_1", terminalId: "term-1" });
  });

  it("decodes a workspace id in the app's encoded route form", () => {
    const workspaceId = "/Users/me/repo";
    const segment = encodeWorkspaceIdForPathSegment(workspaceId);
    expect(segment.startsWith("b64_")).toBe(true);
    expect(buildHostWorkspaceRoute("srv", workspaceId)).toBe(`/h/srv/workspace/${segment}`);

    expect(
      readDesktopNavigationTarget({ serverId: "srv", workspaceId: segment, terminalId: "term-1" }),
    ).toEqual({ kind: "terminal", serverId: "srv", workspaceId, terminalId: "term-1" });
  });

  it("rejects an incomplete terminal target instead of falling back to an agent", () => {
    expect(
      readDesktopNavigationTarget({ serverId: "srv", workspaceId: "wks_1", agentId: "agent-1" }),
    ).toBeNull();
    expect(
      readDesktopNavigationTarget({ serverId: "srv", terminalId: "term-1", agentId: "agent-1" }),
    ).toBeNull();
  });

  it("rejects payloads without a server or a target", () => {
    expect(readDesktopNavigationTarget(null)).toBeNull();
    expect(readDesktopNavigationTarget({ agentId: "agent-1" })).toBeNull();
    expect(readDesktopNavigationTarget({ serverId: "srv" })).toBeNull();
  });
});
