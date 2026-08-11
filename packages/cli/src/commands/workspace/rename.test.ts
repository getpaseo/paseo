import { describe, expect, it } from "vitest";
import type {
  FetchWorkspacesEntry,
  FetchWorkspacesOptions,
} from "@getpaseo/client/internal/daemon-client";
import { createWorkspaceCommand } from "./index.js";
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
  readonly cursors: (string | undefined)[] = [];

  constructor(private readonly pages: FetchWorkspacesEntry[][]) {}

  get pageRequests(): number {
    return this.cursors.length;
  }

  async fetchWorkspaces(options?: FetchWorkspacesOptions) {
    // Page by the cursor the caller sends, so dropping it loops forever here too.
    const index = options?.page?.cursor ? Number(options.page.cursor) : 0;
    this.cursors.push(options?.page?.cursor);
    const entries = this.pages[index] ?? [];
    const hasMore = index + 1 < this.pages.length;
    return { entries, pageInfo: { nextCursor: hasMore ? String(index + 1) : null } };
  }
}

class FailingWorkspaceListClient implements WorkspaceListClient {
  async fetchWorkspaces(): Promise<never> {
    throw new Error("Transport closed (code 1006)");
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
    // An explicit empty title is still a title the caller passed, not a reset.
    expect(catchError(() => resolveWorkspaceTitle({ title: "", reset: true }))).toMatchObject({
      code: "INVALID_OPTIONS",
    });
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

  it("pages with the cursor the daemon returned", async () => {
    const client = new StubWorkspaceListClient([
      [workspaceEntry({ id: "ws-0", name: "main" })],
      [workspaceEntry({ id: "ws-1", name: "feature/auth" })],
    ]);

    expect(await resolveRenameResult(client, "ws-1", null)).toEqual({
      workspaceId: "ws-1",
      name: "feature/auth",
      title: null,
    });
    expect(client.cursors).toEqual([undefined, "1"]);
  });

  it("takes a set title as the display name without listing workspaces", async () => {
    const client = new StubWorkspaceListClient([[workspaceEntry({ name: "feature/auth" })]]);

    expect(await resolveRenameResult(client, "ws-1", "Fix login")).toEqual({
      workspaceId: "ws-1",
      name: "Fix login",
      title: "Fix login",
    });
    expect(client.pageRequests).toBe(0);
  });

  it("reports an unknown name when a reset target is not in the active list", async () => {
    const client = new StubWorkspaceListClient([[]]);

    expect(await resolveRenameResult(client, "ws-1", null)).toEqual({
      workspaceId: "ws-1",
      name: null,
      title: null,
    });
  });

  it("keeps an applied reset successful when the name read-back fails", async () => {
    expect(await resolveRenameResult(new FailingWorkspaceListClient(), "ws-1", null)).toEqual({
      workspaceId: "ws-1",
      name: null,
      title: null,
    });
  });
});

describe("workspace rename arguments", () => {
  function parseRename(argv: string[]): unknown {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "rename")?.exitOverride();
    return catchError(() => workspace.parse(argv, { from: "user" }));
  }

  it("rejects an unquoted multi-word title instead of dropping words", () => {
    expect(parseRename(["rename", "ws-1", "Auth", "rework"])).toMatchObject({
      code: "commander.excessArguments",
    });
  });
});
