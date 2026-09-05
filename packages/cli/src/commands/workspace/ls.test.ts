import { describe, expect, it } from "vitest";
import { renderJson, renderTable, type OutputOptions } from "../../output/index.js";
import {
  runLsCommandWithDeps,
  type FetchWorkspacesOptions,
  type WorkspaceLsClient,
  type WorkspaceLsDeps,
} from "./ls.js";
import type { WorkspaceRowSource } from "./shared.js";

/** Explicit so the command never consults this machine's daemon config for a default. */
const host = "127.0.0.1:6767";

const plainOutput: OutputOptions = {
  format: "table",
  quiet: false,
  noHeaders: true,
  noColor: true,
};

function workspace(overrides: Partial<WorkspaceRowSource> = {}): WorkspaceRowSource {
  return {
    id: "ws-1",
    projectDisplayName: "paseo",
    name: "feature/labels",
    workspaceKind: "worktree",
    workspaceDirectory: "/tmp/paseo/worktrees/feature-labels",
    labels: ["Blocked", "Needs review"],
    gitRuntime: { currentBranch: "feature/labels" },
    githubRuntime: {
      pullRequest: {
        number: 4200,
        url: "https://github.com/getpaseo/paseo/pull/4200",
        title: "Show workspace labels in the CLI",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/labels",
        isMerged: false,
        isDraft: true,
        checksStatus: "pending",
        reviewDecision: null,
      },
    },
    ...overrides,
  };
}

const unlabelled = (): WorkspaceRowSource =>
  workspace({
    id: "ws-2",
    name: "main",
    workspaceKind: "local_checkout",
    workspaceDirectory: "/tmp/paseo",
    labels: undefined,
    gitRuntime: null,
    githubRuntime: null,
  });

/** Serves one page per array entry; the cursor is the index of the next page. */
class FakeWorkspaceLsClient implements WorkspaceLsClient {
  readonly cursors: Array<string | undefined> = [];
  closed = false;

  constructor(
    private readonly pages: WorkspaceRowSource[][],
    private readonly supportsLabels = true,
  ) {}

  getLastServerInfoMessage() {
    return { features: { workspaceLabels: this.supportsLabels } };
  }

  async fetchWorkspaces(options: FetchWorkspacesOptions) {
    const cursor = options.page?.cursor;
    this.cursors.push(cursor);
    const index = cursor ? Number(cursor) : 0;
    return {
      entries: this.pages[index] ?? [],
      pageInfo: { nextCursor: index + 1 < this.pages.length ? String(index + 1) : null },
    };
  }

  async close() {
    this.closed = true;
  }
}

function depsFor(client: WorkspaceLsClient): WorkspaceLsDeps {
  return { connectToDaemon: async () => client };
}

describe("workspace ls", () => {
  it("lists labels, branch, and pull request across every page", async () => {
    const client = new FakeWorkspaceLsClient([[workspace()], [unlabelled()]]);

    const result = await runLsCommandWithDeps({ host }, depsFor(client));

    expect(client.cursors).toEqual([undefined, "1"]);
    expect(client.closed).toBe(true);
    expect(result.data).toEqual([
      {
        workspaceId: "ws-1",
        project: "paseo",
        name: "feature/labels",
        isolation: "worktree",
        labels: ["Blocked", "Needs review"],
        branch: "feature/labels",
        pullRequest: {
          number: 4200,
          url: "https://github.com/getpaseo/paseo/pull/4200",
          title: "Show workspace labels in the CLI",
          state: "draft",
          checksStatus: "pending",
          reviewDecision: null,
        },
        cwd: "/tmp/paseo/worktrees/feature-labels",
      },
      {
        workspaceId: "ws-2",
        project: "paseo",
        name: "main",
        isolation: "local",
        labels: [],
        branch: null,
        pullRequest: null,
        cwd: "/tmp/paseo",
      },
    ]);
  });

  it("keeps only workspaces carrying every requested label, ignoring case", async () => {
    const pages = [[workspace()], [unlabelled()]];

    const both = await runLsCommandWithDeps(
      { host, label: ["blocked", "Needs  review"] },
      depsFor(new FakeWorkspaceLsClient(pages)),
    );
    expect(both.data.map((row) => row.workspaceId)).toEqual(["ws-1"]);

    const missing = await runLsCommandWithDeps(
      { host, label: ["blocked", "shipped"] },
      depsFor(new FakeWorkspaceLsClient(pages)),
    );
    expect(missing.data).toEqual([]);
  });

  it("rejects an empty label before connecting", async () => {
    let connected = false;
    const deps: WorkspaceLsDeps = {
      connectToDaemon: async () => {
        connected = true;
        return new FakeWorkspaceLsClient([]);
      },
    };

    await expect(runLsCommandWithDeps({ host, label: ["  "] }, deps)).rejects.toMatchObject({
      code: "INVALID_LABEL",
    });
    expect(connected).toBe(false);
  });

  it("requires a host that advertises workspace labels when filtering", async () => {
    const client = new FakeWorkspaceLsClient([[workspace()]], false);

    await expect(
      runLsCommandWithDeps({ host, label: ["blocked"] }, depsFor(client)),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to filter workspaces by label.",
    });
    expect(client.closed).toBe(true);

    const unfiltered = await runLsCommandWithDeps({ host }, depsFor(client));
    expect(unfiltered.data.map((row) => row.workspaceId)).toEqual(["ws-1"]);
  });

  it("derives merged and closed pull request states", async () => {
    const merged = workspace({ id: "merged" });
    merged.githubRuntime!.pullRequest!.isMerged = true;
    const closed = workspace({ id: "closed" });
    closed.githubRuntime!.pullRequest!.state = "CLOSED";

    const result = await runLsCommandWithDeps(
      { host },
      depsFor(new FakeWorkspaceLsClient([[merged, closed]])),
    );

    expect(result.data.map((row) => row.pullRequest?.state)).toEqual(["merged", "closed"]);
  });

  it("renders labels and the pull request in table and JSON output", async () => {
    const result = await runLsCommandWithDeps(
      { host },
      depsFor(new FakeWorkspaceLsClient([[workspace(), unlabelled()]])),
    );

    const table = renderTable(result, plainOutput);
    expect(table).toContain("Blocked, Needs review");
    expect(table).toContain("#4200 draft");
    expect(table.split("\n")[1]).toMatch(/local {2,}- {2,}-/);

    const json = JSON.parse(renderJson(result, plainOutput));
    expect(json[0].labels).toEqual(["Blocked", "Needs review"]);
    expect(json[0].branch).toBe("feature/labels");
    expect(json[0].pullRequest.state).toBe("draft");
    expect(json[1]).toMatchObject({ labels: [], branch: null, pullRequest: null });
  });
});
