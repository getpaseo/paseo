import { describe, expect, it } from "vitest";
import { importedSessionWorkspaceNavigation } from "./new-workspace-import-session";

describe("importedSessionWorkspaceNavigation", () => {
  it("opens the imported agent in the workspace created by the daemon", () => {
    expect(
      importedSessionWorkspaceNavigation("server-1", {
        id: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-1",
      target: { kind: "agent", agentId: "agent-1" },
    });
  });

  it("does not build a route when an older daemon omits the workspace id", () => {
    expect(importedSessionWorkspaceNavigation("server-1", { id: "agent-1" })).toBeNull();
  });
});
