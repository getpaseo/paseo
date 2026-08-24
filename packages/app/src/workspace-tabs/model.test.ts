import { describe, expect, it } from "vitest";
import { buildWorkspaceTabPersistenceKey } from "./model";

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
