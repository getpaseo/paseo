import { describe, expect, it } from "vitest";

import type { CheckoutStatusPayload } from "@/hooks/use-checkout-status-query";
import {
  buildNewAgentRoute,
  parseAgentKey,
  resolveNewAgentWorkingDir,
  resolveSelectedAgentForNewAgent,
} from "./new-agent-routing";

describe("buildNewAgentRoute", () => {
  it("falls back to server workspace route with dot workspace when no working directory is provided", () => {
    expect(buildNewAgentRoute("srv-1", undefined)).toBe("/h/srv-1/workspace/Lg");
    expect(buildNewAgentRoute("srv-1", "   ")).toBe("/h/srv-1/workspace/Lg");
  });

  it("encodes the working directory as a workspace path segment", () => {
    expect(buildNewAgentRoute("srv-1", "/Users/me/dev/paseo")).toBe(
      "/h/srv-1/workspace/L1VzZXJzL21lL2Rldi9wYXNlbw",
    );
  });
});

describe("resolveNewAgentWorkingDir", () => {
  it("returns the current cwd for regular checkouts", () => {
    expect(resolveNewAgentWorkingDir("/repo/path", null)).toBe("/repo/path");
  });

  it("falls back to repo root when checkout metadata is unavailable", () => {
    expect(resolveNewAgentWorkingDir("/repo/.paseo/worktrees/feature", null)).toBe("/repo");
  });

  it("supports windows-style paseo worktree paths without checkout metadata", () => {
    expect(resolveNewAgentWorkingDir("C:\\Users\\me\\repo\\.paseo\\worktrees\\feature", null)).toBe(
      "C:\\Users\\me\\repo",
    );
  });

  it("returns the main repo root for paseo-owned worktrees", () => {
    const checkout = {
      isPaseoOwnedWorktree: true,
      worktreeRoot: "/repo/.paseo/worktrees/feature",
      mainRepoRoot: "/repo/main",
    } as unknown as CheckoutStatusPayload;

    expect(resolveNewAgentWorkingDir("/repo/.paseo/worktrees/feature", checkout)).toBe(
      "/repo/main",
    );
  });
});

describe("parseAgentKey", () => {
  it("parses server and agent ids from combined key", () => {
    expect(parseAgentKey("srv-1:agent-9")).toEqual({
      serverId: "srv-1",
      agentId: "agent-9",
    });
  });

  it("uses the last separator to preserve server ids with colons", () => {
    expect(parseAgentKey("localhost:6767:agent-9")).toEqual({
      serverId: "localhost:6767",
      agentId: "agent-9",
    });
  });

  it("returns null for malformed keys", () => {
    expect(parseAgentKey("")).toBeNull();
    expect(parseAgentKey("only-server")).toBeNull();
    expect(parseAgentKey(":agent-1")).toBeNull();
    expect(parseAgentKey("srv-1:")).toBeNull();
  });
});

describe("resolveSelectedAgentForNewAgent", () => {
  it("prefers the agent in the current route", () => {
    expect(
      resolveSelectedAgentForNewAgent({
        pathname: "/h/srv-1/workspace/L3JlcG8?open=agent%3Aagent-2",
        selectedAgentId: "srv-9:agent-9",
      }),
    ).toEqual({
      serverId: "srv-1",
      agentId: "agent-2",
    });
  });

  it("falls back to selected agent key when route has no agent", () => {
    expect(
      resolveSelectedAgentForNewAgent({
        pathname: "/h/srv-1/settings",
        selectedAgentId: "srv-1:agent-7",
      }),
    ).toEqual({
      serverId: "srv-1",
      agentId: "agent-7",
    });
  });

  it("returns null when neither route nor selection has an agent", () => {
    expect(
      resolveSelectedAgentForNewAgent({
        pathname: "/h/srv-1/settings",
      }),
    ).toBeNull();
  });
});
