import { describe, expect, it } from "vitest";

import { buildNotificationRoute, resolveNotificationTarget } from "./notification-routing";

describe("resolveNotificationTarget", () => {
  it("extracts non-empty server and agent ids", () => {
    expect(
      resolveNotificationTarget({
        serverId: " server-123 ",
        agentId: " agent-456 ",
      }),
    ).toEqual({
      serverId: "server-123",
      agentId: "agent-456",
      workspaceId: null,
    });
  });

  it("returns null for missing/empty ids", () => {
    expect(resolveNotificationTarget({ serverId: "", agentId: "   " })).toEqual({
      serverId: null,
      agentId: null,
      workspaceId: null,
    });
    expect(resolveNotificationTarget(undefined)).toEqual({
      serverId: null,
      agentId: null,
      workspaceId: null,
    });
  });

  it("does not treat cwd as a workspace id alias", () => {
    expect(
      resolveNotificationTarget({
        serverId: "srv-1",
        agentId: "agent-1",
        cwd: "/tmp/repo",
      }),
    ).toEqual({
      serverId: "srv-1",
      agentId: "agent-1",
      workspaceId: null,
    });
  });
});

describe("buildNotificationRoute", () => {
  it("routes to workspace with one-shot open intent when workspace id is present", () => {
    expect(
      buildNotificationRoute({
        serverId: "srv-1",
        agentId: "agent-1",
        workspaceId: "ws-main",
      }),
    ).toBe("/h/srv-1/workspace/ws-main?open=agent%3Aagent-1");
  });

  it("routes directly to server-scoped agent path when both ids are present", () => {
    expect(buildNotificationRoute({ serverId: "srv-1", agentId: "agent-1" })).toBe(
      "/h/srv-1/agent/agent-1",
    );
  });

  it("falls back to host root when only serverId is present", () => {
    expect(buildNotificationRoute({ serverId: "srv-only" })).toBe("/h/srv-only");
  });

  it("falls back to root when no server id is present", () => {
    expect(buildNotificationRoute({ agentId: "agent-legacy" })).toBe("/");
    expect(buildNotificationRoute(undefined)).toBe("/");
  });

  it("encodes path segments", () => {
    expect(
      buildNotificationRoute({
        serverId: "srv/with/slash",
        agentId: "agent with space",
      }),
    ).toBe("/h/srv%2Fwith%2Fslash/agent/agent%20with%20space");
  });
});
