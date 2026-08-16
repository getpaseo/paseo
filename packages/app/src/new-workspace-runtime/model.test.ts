import { describe, expect, test } from "vitest";
import type { WorkspaceRuntimeCatalogEntry } from "@getpaseo/protocol/messages";

import {
  resolveWorkspaceProviderProbeTarget,
  resolveWorkspaceProviderSnapshotScope,
  resolveWorkspaceRuntimeSelection,
  runtimeLabel,
} from "./model";

const LOCAL: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "local",
  builtin: true,
  requiresGitProject: false,
};
const WORKTREE: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "worktree",
  builtin: true,
  requiresGitProject: true,
};
const FIXTURE: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "fixture",
  builtin: false,
  label: "Fixture",
  requiresGitProject: true,
};

describe("new workspace runtime selection", () => {
  test("keeps the exact legacy isolation vocabulary when the runtime feature is absent", () => {
    const selection = resolveWorkspaceRuntimeSelection({
      catalog: { status: "legacy" },
      selectedRuntimeId: "worktree",
      supportsMultiplicity: true,
      worktreeSupport: "supported",
    });

    expect(selection).toMatchObject({
      runtimeId: "worktree",
      vocabulary: "isolation",
      canCreateWorkspace: true,
    });
    const translate = (key: string) =>
      ({
        "newWorkspace.isolation.local": "Local",
        "newWorkspace.isolation.worktree": "New worktree",
      })[key] ?? key;
    expect(runtimeLabel(LOCAL, selection.vocabulary, translate)).toBe("Local");
    expect(runtimeLabel(WORKTREE, selection.vocabulary, translate)).toBe("New worktree");
  });

  test.each([
    { catalog: { status: "loading" } as const, expectedError: null },
    {
      catalog: { status: "error", error: "Runtime catalog failed" } as const,
      expectedError: "Runtime catalog failed",
    },
  ])(
    "preserves a remembered runtime and gates creation while the catalog is $catalog.status",
    ({ catalog, expectedError }) => {
      expect(
        resolveWorkspaceRuntimeSelection({
          catalog,
          selectedRuntimeId: "fixture",
          supportsMultiplicity: true,
          worktreeSupport: "supported",
        }),
      ).toMatchObject({
        runtimeId: "fixture",
        availableRuntimes: [],
        canCreateWorkspace: false,
        catalogError: expectedError,
        vocabulary: "runtime",
      });
    },
  );

  test("omits an unavailable runtime after authoritative catalog resolution", () => {
    const selection = resolveWorkspaceRuntimeSelection({
      catalog: { status: "ready", runtimes: [LOCAL, WORKTREE, FIXTURE] },
      selectedRuntimeId: "retired-runtime",
      supportsMultiplicity: true,
      worktreeSupport: "supported",
    });

    expect(selection.runtimeId).toBe("local");
    expect(selection.availableRuntimes.map((runtime) => runtime.runtimeId)).toEqual([
      "local",
      "worktree",
      "fixture",
    ]);
    expect(selection.canCreateWorkspace).toBe(true);
    expect(
      runtimeLabel(WORKTREE, selection.vocabulary, (key) =>
        key === "newWorkspace.runtime.worktree" ? "Worktree" : key,
      ),
    ).toBe("Worktree");
  });

  test("renders registration labels for arbitrary runtime ids without id vocabulary", () => {
    expect(
      runtimeLabel({ runtimeId: "moon-base", label: "Moon Base" }, "runtime", () => "bad"),
    ).toBe("Moon Base");
    expect(
      runtimeLabel({ runtimeId: "shipyard", label: "Container Lab" }, "runtime", () => "bad"),
    ).toBe("Container Lab");
  });
});

describe("new workspace provider probe target", () => {
  test("retains the tagged cwd snapshot only below the runtime feature gate", () => {
    expect(
      resolveWorkspaceProviderProbeTarget({
        supportsWorkspaceRuntimes: false,
        probe: { status: "legacy" },
      }),
    ).toEqual({ kind: "legacy-cwd" });
  });

  test("disables provider snapshots until the selected runtime probe is ready", () => {
    expect(
      resolveWorkspaceProviderProbeTarget({
        supportsWorkspaceRuntimes: true,
        probe: { status: "loading" },
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      resolveWorkspaceProviderProbeTarget({
        supportsWorkspaceRuntimes: true,
        probe: { status: "error", error: "fixture failed" },
      }),
    ).toEqual({ kind: "unavailable" });
  });

  test("keys the existing provider snapshot pipeline by the ensured probe workspace", () => {
    expect(
      resolveWorkspaceProviderProbeTarget({
        supportsWorkspaceRuntimes: true,
        probe: { status: "ready", workspaceId: "probe-fixture" },
      }),
    ).toEqual({ kind: "workspace", workspaceId: "probe-fixture" });
  });

  test("makes a project cwd unreachable while a feature-gated probe is unavailable", () => {
    expect(resolveWorkspaceProviderSnapshotScope({ kind: "unavailable" }, "/host/repo")).toEqual({
      enabled: false,
      cwd: null,
      workspaceId: null,
    });
    expect(
      resolveWorkspaceProviderSnapshotScope(
        { kind: "workspace", workspaceId: "probe-fixture" },
        "/host/repo",
      ),
    ).toEqual({ enabled: true, cwd: null, workspaceId: "probe-fixture" });
    expect(resolveWorkspaceProviderSnapshotScope({ kind: "legacy-cwd" }, "/host/repo")).toEqual({
      enabled: true,
      cwd: "/host/repo",
      workspaceId: null,
    });
  });
});
