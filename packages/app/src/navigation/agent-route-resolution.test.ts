import { describe, expect, it } from "vitest";
import { resolveAgentRoute } from "@/navigation/agent-route-resolution";

const VALID_ROUTE = {
  serverId: "server-1",
  agentId: "agent-1",
  cachedWorkspaceId: null,
} as const;

describe("resolveAgentRoute", () => {
  it("opens a cached workspace without waiting for its host", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        cachedWorkspaceId: "workspace-1",
        connectionStatus: "offline",
        lookup: { kind: "idle" },
      }),
    ).toEqual({ kind: "resolved", workspaceId: "workspace-1" });
  });

  it.each(["idle", "connecting", "offline", "error"] as const)(
    "waits for a %s target host instead of abandoning the agent",
    (connectionStatus) => {
      expect(
        resolveAgentRoute({
          ...VALID_ROUTE,
          connectionStatus,
          lookup: { kind: "idle" },
        }),
      ).toEqual({ kind: "waitingForHost", connectionStatus });
    },
  );

  it("fetches the agent after its target host connects", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        connectionStatus: "online",
        lookup: { kind: "idle" },
      }),
    ).toEqual({ kind: "fetchingAgent" });
  });

  it("opens the workspace returned by the target host", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        connectionStatus: "online",
        lookup: { kind: "found", workspaceId: "workspace-2" },
      }),
    ).toEqual({ kind: "resolved", workspaceId: "workspace-2" });
  });

  it("abandons the agent only after the target host says it is missing", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        connectionStatus: "online",
        lookup: { kind: "found", workspaceId: null },
      }),
    ).toEqual({ kind: "notFound" });
  });

  it("keeps lookup failures retryable", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        connectionStatus: "online",
        lookup: { kind: "failed", error: "connection closed" },
      }),
    ).toEqual({ kind: "lookupError", error: "connection closed" });
  });

  it("rejects incomplete route parameters", () => {
    expect(
      resolveAgentRoute({
        ...VALID_ROUTE,
        agentId: "",
        connectionStatus: "online",
        lookup: { kind: "idle" },
      }),
    ).toEqual({ kind: "invalid" });
  });
});
