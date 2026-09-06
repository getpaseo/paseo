import { describe, expect, it } from "vitest";
import { buildWorkspaceTabPersistenceKey, isWorkspaceTabTargetPersistent } from "./model";

describe("buildWorkspaceTabPersistenceKey", () => {
  it("trims and joins opaque server and workspace ids", () => {
    expect(
      buildWorkspaceTabPersistenceKey({
        serverId: "  server-1  ",
        workspaceId: "  setup\\workspace\\  ",
      }),
    ).toBe("server-1:setup\\workspace\\");
  });

  it("rejects incomplete identities", () => {
    expect(buildWorkspaceTabPersistenceKey({ serverId: "", workspaceId: "workspace" })).toBeNull();
    expect(buildWorkspaceTabPersistenceKey({ serverId: "server", workspaceId: "  " })).toBeNull();
  });
});

describe("isWorkspaceTabTargetPersistent", () => {
  it("matches the workspace layout persistence policy", () => {
    expect(isWorkspaceTabTargetPersistent({ kind: "new_tab" })).toBe(false);
    expect(isWorkspaceTabTargetPersistent({ kind: "commit_diff", sha: "abc123" })).toBe(false);
    expect(isWorkspaceTabTargetPersistent({ kind: "agent", agentId: "agent-1" })).toBe(true);
    expect(isWorkspaceTabTargetPersistent({ kind: "file", path: "/repo/README.md" })).toBe(true);
  });
});
