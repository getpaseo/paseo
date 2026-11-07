import { describe, expect, it } from "vitest";
import {
  WorkspaceAutomationBlockedError,
  assertWorkspaceAutomationAllowed,
  assertWorkspaceAutomationAllowedForWorkspace,
  formatWorkspaceAutomationBlockedMessage,
} from "./workspace-automation-gate.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

describe("workspace automation gate", () => {
  it("refuses executable repository automation for a cross-repository change request", () => {
    expect(() =>
      assertWorkspaceAutomationAllowed({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    ).toThrowError(
      new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    );
  });

  it("allows executable repository automation for ordinary workspaces", () => {
    expect(() => assertWorkspaceAutomationAllowed(undefined)).not.toThrow();
  });

  it.each([null, "2026-11-07T00:00:00Z"])(
    "checks current workspace availability with archivedAt=%s",
    async (archivedAt) => {
      const workspace: PersistedWorkspaceRecord = {
        workspaceId: "workspace",
        projectId: "project",
        cwd: "/repo",
        kind: "directory",
        displayName: "repo",
        title: null,
        branch: null,
        worktreeRoot: null,
        baseBranch: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
        createdAt: "2026-11-07T00:00:00Z",
        updatedAt: "2026-11-07T00:00:00Z",
        archivedAt,
        autoArchivedChangeRequestUrl: null,
        pinnedAt: null,
        background: false,
      };
      const result = assertWorkspaceAutomationAllowedForWorkspace(
        { get: async () => workspace },
        workspace.workspaceId,
      );
      if (archivedAt) {
        await expect(result).rejects.toThrow("Workspace not found: workspace");
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    },
  );

  it("rejects automation after a workspace is removed", async () => {
    await expect(
      assertWorkspaceAutomationAllowedForWorkspace({ get: async () => null }, "removed"),
    ).rejects.toThrow("Workspace not found: removed");
  });

  it.each([
    ["github", "PR"],
    ["gitea", "PR"],
    ["forgejo", "PR"],
    ["gitlab", "MR"],
  ])("uses the %s change request noun", (forge, noun) => {
    expect(
      formatWorkspaceAutomationBlockedMessage({
        kind: "change_request",
        forge,
        number: 42,
        headRepository: "contributor/paseo",
      }),
    ).toBe(`Scripts are blocked for ${noun} #42 from contributor/paseo. Run setup to allow them.`);
  });
});
