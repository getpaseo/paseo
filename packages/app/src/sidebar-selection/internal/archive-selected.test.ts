import { describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  archiveSelectedWorkspaces,
  type BulkArchiveClient,
  type BulkArchiveWorkspacesDeps,
} from "./archive-selected";

function makeEntry(
  overrides: Partial<SidebarWorkspaceEntry> & { workspaceId: string },
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${overrides.workspaceId}`,
    serverId: "srv",
    projectViewKey: "prj-view",
    projectName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${overrides.workspaceId}`,
    workspaceDirectoryLabel: overrides.workspaceId,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: overrides.workspaceId,
    title: null,
    currentBranch: overrides.workspaceId,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    pinnedAt: null,
    background: false,
    labels: [],
    scripts: [],
    hasRunningScripts: false,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    ...overrides,
  };
}

function createFakeToast(): { toast: ToastApi; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    toast: {
      show: () => () => {},
      copied: () => {},
      error: (message) => errors.push(message),
    },
  };
}

function createFakeClient(): BulkArchiveClient {
  return {
    archiveWorkspace: async () => ({ error: null }),
    undoWorkspaceArchive: async () => {},
    getCheckoutStatus: async () =>
      ({
        isGit: true,
        isDirty: false,
        aheadOfOrigin: 0,
      }) as Awaited<ReturnType<BulkArchiveClient["getCheckoutStatus"]>>,
  };
}

describe("archiveSelectedWorkspaces", () => {
  it("archives multiple workspaces with one undo batch and redirects active workspace first", async () => {
    const order: string[] = [];
    const client = createFakeClient();
    const { toast, errors } = createFakeToast();
    const confirmRiskyBulkArchive = vi.fn(async () => true);
    const deps: BulkArchiveWorkspacesDeps = {
      getClient: () => client,
      supportsUndo: () => true,
      readWorktreeRisk: async () => ({ isDirty: false, aheadOfOrigin: 0 }),
      confirmRiskyBulkArchive,
      archiveWithUndo: async (input) => {
        order.push(
          `archive:${input.entries.map((entry) => entry.workspace.workspaceId).join(",")}`,
        );
        return { failures: [], showPartialFailure: () => false };
      },
      archiveWithoutUndo: async () => "archived",
      hasActiveUndo: () => false,
      purgeWorkspaceState: vi.fn(),
      redirectActiveWorkspace: (workspace) => {
        order.push(`redirect:${workspace.workspaceId}`);
      },
    };

    const ok = await archiveSelectedWorkspaces({
      workspaces: [makeEntry({ workspaceId: "w1" }), makeEntry({ workspaceId: "w2" })],
      toast,
      onArchiveStarted: () => order.push("exit-selection"),
      deps,
    });

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(order).toEqual(["redirect:w1", "redirect:w2", "exit-selection", "archive:w1,w2"]);
    expect(confirmRiskyBulkArchive).not.toHaveBeenCalled();
  });

  it("keeps select mode open when the user cancels a risky worktree confirmation", async () => {
    const client = createFakeClient();
    const { toast, errors } = createFakeToast();
    const onArchiveStarted = vi.fn();
    const archiveWithUndo = vi.fn(async () => ({
      failures: [],
      showPartialFailure: () => false,
    }));
    const confirmRiskyBulkArchive = vi.fn(async () => false);

    const ok = await archiveSelectedWorkspaces({
      workspaces: [
        makeEntry({ workspaceId: "w1", workspaceKind: "worktree", name: "feat-wip" }),
        makeEntry({ workspaceId: "w2", workspaceKind: "local_checkout", name: "main" }),
      ],
      toast,
      onArchiveStarted,
      deps: {
        getClient: () => client,
        supportsUndo: () => true,
        readWorktreeRisk: async () => ({ isDirty: true, aheadOfOrigin: 1 }),
        confirmRiskyBulkArchive,
        archiveWithUndo,
        archiveWithoutUndo: async () => "archived",
        hasActiveUndo: () => false,
        purgeWorkspaceState: vi.fn(),
        redirectActiveWorkspace: vi.fn(),
      },
    });

    expect(ok).toBe(false);
    expect(errors).toEqual([]);
    expect(confirmRiskyBulkArchive).toHaveBeenCalledWith({
      totalCount: 2,
      riskyWorkspaces: [
        {
          workspaceName: "feat-wip",
          diffStat: null,
          isDirty: true,
          aheadOfOrigin: 1,
        },
      ],
    });
    expect(onArchiveStarted).not.toHaveBeenCalled();
    expect(archiveWithUndo).not.toHaveBeenCalled();
  });

  it("shows a disconnect error and aborts before archiving when any host is offline", async () => {
    const { toast, errors } = createFakeToast();
    const onArchiveStarted = vi.fn();

    const ok = await archiveSelectedWorkspaces({
      workspaces: [makeEntry({ workspaceId: "w1" })],
      toast,
      onArchiveStarted,
      deps: {
        getClient: () => null,
        supportsUndo: () => true,
        readWorktreeRisk: vi.fn(),
        confirmRiskyBulkArchive: vi.fn(),
        archiveWithUndo: vi.fn(),
        archiveWithoutUndo: vi.fn(),
        hasActiveUndo: () => false,
        purgeWorkspaceState: vi.fn(),
        redirectActiveWorkspace: vi.fn(),
      },
    });

    expect(ok).toBe(false);
    expect(errors).toEqual(["Host is not connected"]);
    expect(onArchiveStarted).not.toHaveBeenCalled();
  });

  it("reports multi-workspace failures when more than one archive fails", async () => {
    const client = createFakeClient();
    const { toast, errors } = createFakeToast();

    const ok = await archiveSelectedWorkspaces({
      workspaces: [makeEntry({ workspaceId: "w1" }), makeEntry({ workspaceId: "w2" })],
      toast,
      onArchiveStarted: vi.fn(),
      deps: {
        getClient: () => client,
        supportsUndo: () => true,
        readWorktreeRisk: vi.fn(),
        confirmRiskyBulkArchive: vi.fn(),
        archiveWithUndo: async () => ({
          failures: [
            { workspace: { serverId: "srv", workspaceId: "w1" }, error: new Error("boom 1") },
            { workspace: { serverId: "srv", workspaceId: "w2" }, error: new Error("boom 2") },
          ],
          showPartialFailure: () => false,
        }),
        archiveWithoutUndo: vi.fn(),
        hasActiveUndo: () => false,
        purgeWorkspaceState: vi.fn(),
        redirectActiveWorkspace: vi.fn(),
      },
    });

    expect(ok).toBe(false);
    expect(errors).toEqual(["Failed to archive 2 workspaces"]);
  });

  it("keeps Undo open via showPartialFailure instead of replacing it with toast.error on partial failure", async () => {
    const client = createFakeClient();
    const { toast, errors } = createFakeToast();
    const partialErrors: string[] = [];

    const ok = await archiveSelectedWorkspaces({
      workspaces: [makeEntry({ workspaceId: "w1" }), makeEntry({ workspaceId: "w2" })],
      toast,
      onArchiveStarted: vi.fn(),
      deps: {
        getClient: () => client,
        supportsUndo: () => true,
        readWorktreeRisk: vi.fn(),
        confirmRiskyBulkArchive: vi.fn(),
        archiveWithUndo: async () => ({
          failures: [
            { workspace: { serverId: "srv", workspaceId: "w2" }, error: new Error("Host offline") },
          ],
          showPartialFailure: (message) => {
            partialErrors.push(message);
            return true;
          },
        }),
        archiveWithoutUndo: vi.fn(),
        hasActiveUndo: () => false,
        purgeWorkspaceState: vi.fn(),
        redirectActiveWorkspace: vi.fn(),
      },
    });

    expect(ok).toBe(false);
    expect(partialErrors).toEqual(["Host offline"]);
    expect(errors).toEqual([]);
  });

  it("routes a late failure from a superseded batch to fallbackErrorToast so a newer batch keeps its Undo", async () => {
    const client = createFakeClient();
    const sidebar = createFakeToast();
    const app = createFakeToast();

    const ok = await archiveSelectedWorkspaces({
      workspaces: [makeEntry({ workspaceId: "w1" })],
      toast: sidebar.toast,
      fallbackErrorToast: app.toast,
      onArchiveStarted: vi.fn(),
      deps: {
        getClient: () => client,
        supportsUndo: () => true,
        readWorktreeRisk: vi.fn(),
        confirmRiskyBulkArchive: vi.fn(),
        archiveWithUndo: async () => ({
          failures: [
            {
              workspace: { serverId: "srv", workspaceId: "w1" },
              error: new Error("Host timed out"),
            },
          ],
          // This batch's own undo window was closed when a newer batch superseded it.
          showPartialFailure: () => false,
        }),
        archiveWithoutUndo: vi.fn(),
        hasActiveUndo: () => true,
        purgeWorkspaceState: vi.fn(),
        redirectActiveWorkspace: vi.fn(),
      },
    });

    expect(ok).toBe(false);
    expect(sidebar.errors).toEqual([]);
    expect(app.errors).toEqual(["Host timed out"]);
  });
});
