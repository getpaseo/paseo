import { describe, expect, it } from "vitest";
import {
  mapDirectorySuggestionsToCommandCenterFiles,
  resolveCommandCenterWorkspaceScope,
} from "./command-center-file-search";

describe("resolveCommandCenterWorkspaceScope", () => {
  it("uses the current workspace route when available", () => {
    expect(
      resolveCommandCenterWorkspaceScope({
        pathname: "/h/local/workspace/L3RtcC9yZXBv",
        agents: [],
      }),
    ).toEqual({
      serverId: "local",
      workspaceId: "/tmp/repo",
    });
  });

  it("falls back to the current agent cwd on agent routes", () => {
    expect(
      resolveCommandCenterWorkspaceScope({
        pathname: "/h/local/agent/agent-1",
        agents: [
          {
            id: "agent-1",
            cwd: " /tmp/repo/worktree ",
            serverId: "local",
          },
        ],
      }),
    ).toEqual({
      serverId: "local",
      workspaceId: "/tmp/repo/worktree",
    });
  });

  it("returns null when the current route has no workspace context", () => {
    expect(
      resolveCommandCenterWorkspaceScope({
        pathname: "/settings",
        agents: [],
      }),
    ).toBeNull();
  });
});

describe("mapDirectorySuggestionsToCommandCenterFiles", () => {
  it("keeps only file entries and derives file labels", () => {
    expect(
      mapDirectorySuggestionsToCommandCenterFiles({
        entries: [
          { path: "src/components/command-center.tsx", kind: "file" },
          { path: "src/components", kind: "directory" },
          { path: ".env", kind: "file" },
        ],
      }),
    ).toEqual([
      {
        path: "src/components/command-center.tsx",
        name: "command-center.tsx",
        directory: "src/components",
      },
      {
        path: ".env",
        name: ".env",
        directory: ".",
      },
    ]);
  });
});
