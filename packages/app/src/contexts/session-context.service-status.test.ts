import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@server/shared/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { patchWorkspaceScripts } from "./session-workspace-scripts";

function workspace(input: {
  id: string;
  workspaceDirectory?: string;
  scripts?: WorkspaceDescriptor["scripts"];
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: "project-1",
    projectDisplayName: "Project 1",
    projectRootPath: "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo/main",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "main",
    status: "running",
    diffStat: null,
    scripts: input.scripts ?? [],
  };
}

const runningScript: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web.paseo.localhost",
  port: 3000,
  proxyUrl: "http://web.paseo.localhost:6767",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

describe("patchWorkspaceScripts", () => {
  it("patches only the matching workspace scripts", () => {
    const other = workspace({ id: "ws-other", workspaceDirectory: "/repo/other", scripts: [] });
    const current = new Map<string, WorkspaceDescriptor>([
      ["ws-main", workspace({ id: "ws-main", workspaceDirectory: "/repo/main", scripts: [] })],
      [other.id, other],
    ]);

    const next = patchWorkspaceScripts(current, {
      workspaceId: "ws-main",
      scripts: [runningScript],
    });

    expect(next).not.toBe(current);
    expect(next.get("ws-main")?.scripts).toEqual([runningScript]);
    expect(next.get("ws-other")).toBe(other);
  });

  it("patches the matching workspace when the map key differs from the workspace id", () => {
    const current = new Map<string, WorkspaceDescriptor>([
      [
        "workspace-record-42",
        workspace({
          id: "ws-main",
          workspaceDirectory: "C:\\repo\\main\\",
          scripts: [],
        }),
      ],
    ]);

    const next = patchWorkspaceScripts(current, {
      workspaceId: "ws-main",
      scripts: [runningScript],
    });

    expect(next).not.toBe(current);
    expect(next.get("workspace-record-42")?.scripts).toEqual([runningScript]);
  });

  it("ignores updates for unknown workspaces", () => {
    const current = new Map<string, WorkspaceDescriptor>([
      ["ws-main", workspace({ id: "ws-main", workspaceDirectory: "/repo/main", scripts: [] })],
    ]);

    const next = patchWorkspaceScripts(current, {
      workspaceId: "ws-missing",
      scripts: [runningScript],
    });

    expect(next).toBe(current);
    expect(next.get("ws-main")?.scripts).toEqual([]);
  });
});
