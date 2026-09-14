import { describe, expect, it } from "vitest";
import { resolveWorkspaceRecoveryModel } from "./model";

describe("resolveWorkspaceRecoveryModel", () => {
  it("keeps newer recovery actions visible but non-actionable", () => {
    expect(
      resolveWorkspaceRecoveryModel({
        enabled: true,
        connected: true,
        hasClient: true,
        hasServerInfo: true,
        supportsRecovery: true,
        inspection: {
          pending: false,
          error: null,
          data: {
            kind: "recoverable",
            workspaceId: "workspace-1",
            workspaceName: "Feature branch",
            action: "repair_from_snapshot",
            branch: "feature",
          },
        },
        restore: { pending: false, error: null },
      }),
    ).toEqual({
      kind: "unsupportedAction",
      action: "repair_from_snapshot",
    });
  });
});
