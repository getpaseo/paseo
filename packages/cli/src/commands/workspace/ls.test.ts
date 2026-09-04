import { describe, expect, it } from "vitest";
import { renderTable } from "../../output/table.js";
import { matchesWorkspaceLabelFilters, parseWorkspaceLabelFilters } from "./ls.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRowSource } from "./shared.js";

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

describe("toWorkspaceRow", () => {
  it("carries labels, branch, and the pull request into the row", () => {
    expect(toWorkspaceRow(workspace())).toEqual({
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
    });
  });

  it("leaves metadata empty when the host has none", () => {
    expect(
      toWorkspaceRow(
        workspace({
          workspaceKind: "local_checkout",
          labels: undefined,
          gitRuntime: null,
          githubRuntime: null,
        }),
      ),
    ).toMatchObject({ isolation: "local", labels: [], branch: null, pullRequest: null });
  });

  it("derives merged and closed pull request states", () => {
    const merged = workspace();
    merged.githubRuntime!.pullRequest!.isMerged = true;
    expect(toWorkspaceRow(merged).pullRequest?.state).toBe("merged");

    const closed = workspace();
    closed.githubRuntime!.pullRequest!.state = "CLOSED";
    expect(toWorkspaceRow(closed).pullRequest?.state).toBe("closed");
  });

  it("renders labels and the pull request as table cells", () => {
    const line = renderTable(
      { type: "list", data: [toWorkspaceRow(workspace())], schema: workspaceSchema },
      { format: "table", quiet: false, noHeaders: true, noColor: true },
    );
    expect(line).toContain("Blocked, Needs review");
    expect(line).toContain("#4200 draft");
  });
});

describe("workspace label filters", () => {
  it("normalizes and dedupes requested labels", () => {
    expect(parseWorkspaceLabelFilters([" Blocked ", "blocked", "Needs  review"])).toEqual([
      "blocked",
      "needs review",
    ]);
    expect(parseWorkspaceLabelFilters(undefined)).toEqual([]);
  });

  it("rejects an empty label", () => {
    expect(() => parseWorkspaceLabelFilters(["  "])).toThrow(
      expect.objectContaining({ code: "INVALID_LABEL" }),
    );
  });

  it("requires every requested label, ignoring case", () => {
    const labels = ["Blocked", "Needs review"];
    expect(matchesWorkspaceLabelFilters(labels, [])).toBe(true);
    expect(matchesWorkspaceLabelFilters(labels, ["blocked"])).toBe(true);
    expect(matchesWorkspaceLabelFilters(labels, ["blocked", "needs review"])).toBe(true);
    expect(matchesWorkspaceLabelFilters(labels, ["blocked", "shipped"])).toBe(false);
    expect(matchesWorkspaceLabelFilters([], ["blocked"])).toBe(false);
  });
});
