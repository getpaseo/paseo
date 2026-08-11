import { describe, expect, it } from "vitest";
import type { FetchWorkspacesEntry } from "@getpaseo/client/internal/daemon-client";
import { resolveRenameResult, resolveWorkspaceTitle } from "./rename.js";
import type { WorkspaceListClient } from "./shared.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

function workspaceEntry(overrides: Partial<FetchWorkspacesEntry>): FetchWorkspacesEntry {
  return {
    id: "ws-1",
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/tmp/paseo",
    workspaceDirectory: "/tmp/paseo/worktrees/feature-auth",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "feature/auth",
    title: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
}

class StubWorkspaceListClient implements WorkspaceListClient {
  pageRequests = 0;

  constructor(private readonly pages: FetchWorkspacesEntry[][]) {}

  async fetchWorkspaces() {
    const entries = this.pages[this.pageRequests] ?? [];
    this.pageRequests += 1;
    const hasMore = this.pageRequests < this.pages.length;
    return { entries, pageInfo: { nextCursor: hasMore ? `cursor-${this.pageRequests}` : null } };
  }
}

describe("workspace rename title", () => {
  it("trims the requested title", () => {
    expect(resolveWorkspaceTitle({ title: "  Fix login  " })).toBe("Fix login");
  });

  it("clears the title when resetting to the derived name", () => {
    expect(resolveWorkspaceTitle({ reset: true })).toBeNull();
  });

  it("rejects a reset that also carries a title", () => {
    expect(
      catchError(() => resolveWorkspaceTitle({ title: "Fix login", reset: true })),
    ).toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("requires a non-empty title when not resetting", () => {
    expect(catchError(() => resolveWorkspaceTitle({}))).toMatchObject({ code: "MISSING_TITLE" });
    expect(catchError(() => resolveWorkspaceTitle({ title: "   " }))).toMatchObject({
      code: "MISSING_TITLE",
    });
  });
});

describe("workspace rename result", () => {
  it("reports the derived name a reset reverted to", async () => {
    const client = new StubWorkspaceListClient([[workspaceEntry({ name: "feature/auth" })]]);

    expect(await resolveRenameResult(client, "ws-1", null)).toEqual({
      workspaceId: "ws-1",
      name: "feature/auth",
      title: null,
    });
  });

  it("finds the workspace beyond the first page", async () => {
    const client = new StubWorkspaceListClient([
      [workspaceEntry({ id: "ws-0", name: "main" })],
      [workspaceEntry({ id: "ws-1", name: "Fix login", title: "Fix login" })],
    ]);

    expect(await resolveRenameResult(client, "ws-1", "Fix login")).toEqual({
      workspaceId: "ws-1",
      name: "Fix login",
      title: "Fix login",
    });
    expect(client.pageRequests).toBe(2);
  });

  it("falls back to the applied title when the descriptor is missing", async () => {
    const client = new StubWorkspaceListClient([[]]);

    expect(await resolveRenameResult(client, "ws-1", "Fix login")).toEqual({
      workspaceId: "ws-1",
      name: "Fix login",
      title: "Fix login",
    });
  });
});
