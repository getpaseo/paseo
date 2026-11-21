import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import yaml from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceCommand } from "./index.js";

const { fetchWorkspaces, getLastServerInfoMessage, close } = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  getLastServerInfoMessage: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: async () => ({ fetchWorkspaces, getLastServerInfoMessage, close }),
  getDaemonHost: () => "example.test:6767",
}));

function workspace(id: string, extra: Record<string, unknown> = {}) {
  return WorkspaceDescriptorPayloadSchema.parse({
    id,
    name: id,
    projectId: "project-1",
    projectDisplayName: "Example",
    projectRootPath: "/example",
    workspaceDirectory: `/example/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    status: "done",
    activityAt: null,
    ...extra,
  });
}

function page(entries: ReturnType<typeof workspace>[], nextCursor: string | null = null) {
  return { entries, pageInfo: { nextCursor, prevCursor: null, hasMore: nextCursor !== null } };
}

async function list(...args: string[]) {
  const command = createWorkspaceCommand();
  command.option("--format <format>");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await command.parseAsync(["ls", "--host", "example.test:6767", ...args], { from: "user" });
    return stdout.mock.calls.map(([chunk]) => chunk).join("");
  } finally {
    stdout.mockRestore();
  }
}

describe("workspace ls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getLastServerInfoMessage.mockReturnValue({ features: { workspaceLabels: true } });
  });

  it("matches any supplied label across pages and preserves the background option", async () => {
    fetchWorkspaces
      .mockResolvedValueOnce(page([workspace("unlabeled")], "next"))
      .mockResolvedValueOnce(
        page([
          workspace("review", { labels: ["Needs review"] }),
          workspace("blocked", { labels: ["Blocked"], background: true }),
          workspace("done", { labels: ["Done"] }),
        ]),
      );

    const result = JSON.parse(
      await list("--label", "  NEEDS   review ", "--label", "blocked", "--background", "--json"),
    );

    expect(result).toMatchObject([
      { workspaceId: "review", labels: ["Needs review"], background: false },
      { workspaceId: "blocked", labels: ["Blocked"], background: true },
    ]);
    expect(fetchWorkspaces.mock.calls).toEqual([
      [{ filter: { includeBackground: true }, page: { limit: 200 } }],
      [{ filter: { includeBackground: true }, page: { limit: 200, cursor: "next" } }],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shows workspace labels, branch, and PR metadata in table, JSON, and YAML", async () => {
    fetchWorkspaces.mockResolvedValue(
      page([
        workspace("review", {
          labels: ["Needs review"],
          gitRuntime: { currentBranch: "feature/auth" },
          githubRuntime: {
            pullRequest: {
              number: 42,
              title: "Auth",
              url: "https://example.test/repo/pull/42",
              headRefName: "feature/auth",
              baseRefName: "main",
              state: "OPEN",
              isMerged: false,
              isDraft: true,
              checksStatus: "failure",
              reviewDecision: "changes_requested",
              mergeable: "CONFLICTING",
            },
          },
        }),
        workspace("unlabeled"),
      ]),
    );

    const result = JSON.parse(await list("--json"));
    expect(result).toMatchObject([
      {
        workspaceId: "review",
        labels: ["Needs review"],
        branch: "feature/auth",
        pullRequest: {
          number: 42,
          title: "Auth",
          url: "https://example.test/repo/pull/42",
          state: "open",
          isDraft: true,
          checksStatus: "failure",
          reviewDecision: "changes_requested",
          mergeable: "CONFLICTING",
        },
      },
      { workspaceId: "unlabeled", labels: [], branch: null, pullRequest: null },
    ]);
    expect(yaml.parse(await list("--format", "yaml"))).toEqual(result);
    const table = await list();
    expect(table).toMatch(/LABELS +BRANCH +PR/);
    expect(table).toMatch(/Needs review +feature\/auth +#42 draft/);
  });

  it("uses the recorded branch before a snapshot arrives and preserves detached HEAD", async () => {
    const project = {
      projectKey: "project-1",
      projectName: "Example",
      checkout: {
        cwd: "/example/checkout",
        isGit: true,
        isPaseoOwnedWorktree: false,
        currentBranch: "feature/recorded",
        remoteUrl: null,
      },
    };
    fetchWorkspaces.mockResolvedValue(
      page([
        workspace("cold", { project }),
        workspace("detached", { project, gitRuntime: { currentBranch: null } }),
      ]),
    );

    expect(JSON.parse(await list("--json"))).toMatchObject([
      { workspaceId: "cold", branch: "feature/recorded" },
      { workspaceId: "detached", branch: null },
    ]);
  });

  it("rejects filtering on older hosts instead of returning a false empty result", async () => {
    getLastServerInfoMessage.mockReturnValue({ features: {} });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exited");
    });
    try {
      await expect(list("--label", "Needs review", "--json")).rejects.toThrow("CLI exited");
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
        error: { code: "DAEMON_UPDATE_REQUIRED" },
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(fetchWorkspaces).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
