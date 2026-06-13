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
      terminalId: null,
    });
  });

  it("returns null for missing/empty ids", () => {
    expect(resolveNotificationTarget({ serverId: "", agentId: "   " })).toEqual({
      serverId: null,
      agentId: null,
      workspaceId: null,
      terminalId: null,
    });
    expect(resolveNotificationTarget(undefined)).toEqual({
      serverId: null,
      agentId: null,
      workspaceId: null,
      terminalId: null,
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
      terminalId: null,
    });
  });
});

describe("buildNotificationRoute", () => {
  it("routes to the agent path when workspace id is present", () => {
    expect(
      buildNotificationRoute({
        serverId: "srv-1",
        agentId: "agent-1",
        workspaceId: "ws-main",
      }),
    ).toBe("/h/srv-1/agent/agent-1");
  });

  it("routes directly to server-scoped agent path when both ids are present", () => {
    expect(buildNotificationRoute({ serverId: "srv-1", agentId: "agent-1" })).toBe(
      "/h/srv-1/agent/agent-1",
    );
  });

  it("routes to the workspace terminal tab when workspace and terminal ids are present", () => {
    expect(
      buildNotificationRoute({
        serverId: "srv-1",
        workspaceId: "ws-main",
        terminalId: "term-1",
      }),
    ).toBe("/h/srv-1/workspace/ws-main?open=terminal%3Aterm-1");
  });

  it("falls back to host root for a terminal without a workspace id", () => {
    expect(
      buildNotificationRoute({
        serverId: "srv-1",
        terminalId: "term-1",
        cwd: "/tmp/repo",
      }),
    ).toBe("/h/srv-1");
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
