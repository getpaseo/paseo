import { describe, expect, it } from "vitest";

import {
  searchLiveVoiceWorkspaces,
  type LiveVoiceWorkspaceCandidate,
} from "./live-voice-workspace-search.js";

function workspace(
  overrides: Partial<LiveVoiceWorkspaceCandidate> & { workspaceId: string },
): LiveVoiceWorkspaceCandidate {
  return {
    serverId: "server-a",
    hostLabel: "Desktop",
    title: null,
    cwd: null,
    ...overrides,
  };
}

describe("live voice workspace search", () => {
  it("resolves a spoken title to one workspace", () => {
    const result = searchLiveVoiceWorkspaces("Refresh Paseo assembly", [
      workspace({ workspaceId: "ws-1", title: "Refresh Paseo assembly" }),
      workspace({ workspaceId: "ws-2", title: "Live voice routing" }),
    ]);

    expect(result.resolution).toBe("unique_exact");
    expect(result.matches).toEqual([
      expect.objectContaining({ workspaceId: "ws-1", matchKind: "exact" }),
    ]);
  });

  it("ignores the case, punctuation and hyphens a transcriber invents", () => {
    const result = searchLiveVoiceWorkspaces("refresh paseo assembly.", [
      workspace({ workspaceId: "ws-1", title: "Refresh  Paseo-Assembly" }),
    ]);

    expect(result.resolution).toBe("unique_exact");
  });

  it("matches the directory name when a workspace has no title", () => {
    const result = searchLiveVoiceWorkspaces("refresh paseo assembly", [
      workspace({ workspaceId: "ws-1", cwd: "/home/ivan/.worktrees/refresh-paseo-assembly" }),
    ]);

    expect(result.resolution).toBe("unique_exact");
    expect(result.matches[0]?.workspaceId).toBe("ws-1");
  });

  it("reports two hosts with the same workspace name as ambiguous rather than picking one", () => {
    const result = searchLiveVoiceWorkspaces("Refresh Paseo assembly", [
      workspace({ workspaceId: "ws-1", serverId: "server-a", title: "Refresh Paseo assembly" }),
      workspace({
        workspaceId: "ws-2",
        serverId: "server-b",
        hostLabel: "Laptop",
        title: "Refresh Paseo assembly",
      }),
    ]);

    expect(result.resolution).toBe("ambiguous_exact");
    expect(result.matches.map((match) => match.serverId)).toEqual(["server-a", "server-b"]);
  });

  it("keeps an exact match from being diluted by looser ones", () => {
    const result = searchLiveVoiceWorkspaces("paseo", [
      workspace({ workspaceId: "ws-1", title: "Paseo" }),
      workspace({ workspaceId: "ws-2", title: "Paseo assembly refresh" }),
      workspace({ workspaceId: "ws-3", title: "Paseo docs" }),
    ]);

    expect(result.resolution).toBe("unique_exact");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.workspaceId).toBe("ws-1");
  });

  it("marks a lone loose match as partial so the caller confirms first", () => {
    const result = searchLiveVoiceWorkspaces("assembly", [
      workspace({ workspaceId: "ws-1", title: "Refresh Paseo assembly" }),
      workspace({ workspaceId: "ws-2", title: "Live voice routing" }),
    ]);

    expect(result.resolution).toBe("unique_partial");
    expect(result.matches[0]).toMatchObject({ workspaceId: "ws-1", matchKind: "partial" });
  });

  it("matches every spoken word in any order before giving up", () => {
    const result = searchLiveVoiceWorkspaces("assembly refresh", [
      workspace({ workspaceId: "ws-1", title: "Refresh Paseo assembly" }),
    ]);

    expect(result.resolution).toBe("unique_partial");
  });

  it("reports several loose matches as ambiguous", () => {
    const result = searchLiveVoiceWorkspaces("paseo", [
      workspace({ workspaceId: "ws-1", title: "Paseo assembly" }),
      workspace({ workspaceId: "ws-2", title: "Paseo docs" }),
    ]);

    expect(result.resolution).toBe("ambiguous_partial");
    expect(result.matches).toHaveLength(2);
  });

  it("returns nothing rather than a near miss", () => {
    const result = searchLiveVoiceWorkspaces("taffybar", [
      workspace({ workspaceId: "ws-1", title: "Refresh Paseo assembly" }),
    ]);

    expect(result).toEqual({ resolution: "none", matches: [] });
  });

  it("treats a query of pure punctuation as no query at all", () => {
    const result = searchLiveVoiceWorkspaces("...", [
      workspace({ workspaceId: "ws-1", title: "Refresh Paseo assembly" }),
    ]);

    expect(result.resolution).toBe("none");
  });
});
