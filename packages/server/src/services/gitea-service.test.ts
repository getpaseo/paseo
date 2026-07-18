import { describe, expect, it } from "vitest";

import type { PullRequestCommandStatus, PullRequestTimelineItem } from "./forge-service.js";
import {
  type CreateGiteaServiceOptions,
  createGiteaService,
  detectGiteaFamilySoftware,
  TeaAuthenticationError,
  TeaCommandError,
  type TeaCommandResult,
  type TeaCommandRunner,
} from "./gitea-service.js";

type Responder = (args: string[]) => TeaCommandResult | Promise<TeaCommandResult>;

function ok(stdout: string): TeaCommandResult {
  return { stdout, stderr: "" };
}

function makeService(responder: Responder, overrides: Partial<CreateGiteaServiceOptions> = {}) {
  const calls: string[][] = [];
  const runner: TeaCommandRunner = async (args) => {
    calls.push(args);
    return responder(args);
  };
  const service = createGiteaService({
    runner,
    resolveTeaPath: async () => "/usr/bin/tea",
    resolveRemoteUrl: async () => "https://gitea.com/example-user/sample-repo.git",
    ...overrides,
  });
  return { service, calls };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function locatedCommentThreadId(
  item: PullRequestTimelineItem,
): [string, string | undefined] | null {
  if (item.kind !== "comment" || !item.location) {
    return null;
  }
  return [item.id, item.location.threadId];
}

// `tea pr list -o json` shape: every value is a string, including
// numeric/boolean fields (index, mergeable, comments, ci).
const OPEN_PR = {
  index: "5",
  state: "open",
  author: "example-user",
  url: "https://gitea.com/example-user/sample-repo/pulls/5",
  title: "Add sample feature",
  body: "Implements the sample feature",
  mergeable: "true",
  base: "main",
  head: "feat/sample-change",
  created: "2026-06-26T09:00:00Z",
  updated: "2026-06-26T10:00:00Z",
  labels: "enhancement,review",
  comments: "2",
  ci: "success",
};

const CONFLICTING_PR = {
  ...OPEN_PR,
  index: "6",
  url: "https://gitea.com/example-user/sample-repo/pulls/6",
  head: "feat/conflict",
  mergeable: "false",
  ci: "failure",
};

function currentPullRequestApi(input: {
  number: number;
  state: "open" | "closed";
  headRef: string;
  headSha: string;
  merged?: boolean;
}) {
  return {
    number: input.number,
    html_url: `https://gitea.com/example-user/sample-repo/pulls/${input.number}`,
    title: "Historical pull request",
    body: "",
    state: input.state,
    merged: input.merged ?? false,
    mergeable: true,
    updated_at: "2026-06-26T10:00:00Z",
    labels: [],
    head: {
      ref: input.headRef,
      sha: input.headSha,
      repo: { id: 1, owner: { login: "example-user" } },
    },
    base: {
      ref: "main",
      repo: { id: 1, owner: { login: "example-user" } },
    },
  };
}

const STATUS_PR_VIEW = {
  id: 161482,
  index: 5,
  title: "Add sample feature",
  state: "open",
  created: "2026-06-28T16:25:00Z",
  updated: "2026-06-28T16:25:04Z",
  labels: [],
  user: "example-user",
  body: "Implements the sample feature",
  assignees: [],
  url: "https://gitea.com/example-user/sample-repo/pulls/5",
  base: "main",
  head: "feat/sample-change",
  headSha: "3333333333333333333333333333333333333333",
  diffUrl: "https://gitea.com/example-user/sample-repo/pulls/5.diff",
  mergeable: true,
  hasMerged: false,
  mergedAt: null,
  closedAt: null,
  reviews: [],
  comments: [],
};

const STATUS_CREATOR = {
  id: 213843,
  login: "example-user",
  login_name: "",
  source_id: 0,
  full_name: "",
  email: "1+example-user@noreply.gitea.com",
  avatar_url:
    "https://gitea.com/avatars/0000000000000000000000000000000000000000000000000000000000000000",
  html_url: "https://gitea.com/example-user",
  language: "",
  is_admin: false,
  last_login: "0001-01-01T00:00:00Z",
  created: "2026-06-27T18:29:03Z",
  restricted: false,
  active: false,
  prohibit_login: false,
  location: "",
  website: "",
  description: "",
  visibility: "public",
  followers_count: 0,
  following_count: 0,
  starred_repos_count: 0,
  username: "example-user",
};

const SAMPLE_STATUS_REPO = "sample-repo";

const SAMPLE_COMBINED_STATUS = {
  state: "pending",
  sha: "3333333333333333333333333333333333333333",
  total_count: 2,
  statuses: [
    {
      id: 1,
      status: "success",
      target_url: "https://example.invalid/ci/test",
      description: "Tests passed",
      url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/statuses/3333333333333333333333333333333333333333`,
      context: "ci/test",
      creator: STATUS_CREATOR,
      created_at: "2026-06-28T16:25:03Z",
      updated_at: "2026-06-28T16:25:03Z",
    },
    {
      id: 2,
      status: "pending",
      target_url: "https://example.invalid/ci/lint",
      description: "Lint running",
      url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/statuses/3333333333333333333333333333333333333333`,
      context: "ci/lint",
      creator: STATUS_CREATOR,
      created_at: "2026-06-28T16:25:04Z",
      updated_at: "2026-06-28T16:25:04Z",
    },
  ],
  repository: {
    id: 135972,
    owner: STATUS_CREATOR,
    name: SAMPLE_STATUS_REPO,
    full_name: `example-user/${SAMPLE_STATUS_REPO}`,
    description: "",
    empty: false,
    private: true,
    fork: false,
    template: false,
    mirror: false,
    size: 27,
    language: "",
    languages_url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/languages`,
    html_url: `https://gitea.com/example-user/${SAMPLE_STATUS_REPO}`,
    url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}`,
    ssh_url: `git@gitea.com:example-user/${SAMPLE_STATUS_REPO}.git`,
    clone_url: `https://gitea.com/example-user/${SAMPLE_STATUS_REPO}.git`,
    default_branch: "main",
    has_actions: true,
    permissions: { admin: true, push: true, pull: true },
    object_format_name: "sha1",
  },
  commit_url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/commits/3333333333333333333333333333333333333333`,
  url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/commits/3333333333333333333333333333333333333333/status`,
};

const SAMPLE_COMMIT_STATUSES = [
  SAMPLE_COMBINED_STATUS.statuses[1],
  SAMPLE_COMBINED_STATUS.statuses[0],
];

const SAMPLE_ACTIONS_TASKS = {
  workflow_runs: [
    {
      id: 6979709,
      name: "verify",
      head_branch: "main",
      head_sha: "2222222222222222222222222222222222222222",
      run_number: 3,
      event: "push",
      display_title: "chore: add MIT license",
      status: "success",
      workflow_id: "ci.yml",
      url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
      created_at: "2026-06-28T18:48:20+02:00",
      updated_at: "2026-06-28T18:48:38+02:00",
      run_started_at: "2026-06-28T18:48:20+02:00",
    },
    {
      id: 6979634,
      name: "verify",
      head_branch: "main",
      head_sha: "4444444444444444444444444444444444444444",
      run_number: 2,
      event: "push",
      display_title: "ci: trigger run",
      status: "success",
      workflow_id: "ci.yml",
      url: "https://codeberg.org/example-user/sample-repo/actions/runs/2",
      created_at: "2026-06-28T18:43:50+02:00",
      updated_at: "2026-06-28T18:44:06+02:00",
      run_started_at: "2026-06-28T18:43:50+02:00",
    },
  ],
  total_count: 2,
};

const OPEN_ISSUE = {
  index: "3",
  state: "open",
  author: "example-user",
  url: "https://gitea.com/example-user/sample-repo/issues/3",
  title: "Login button misaligned",
  body: "On mobile the button overflows",
  labels: "bug",
  comments: "1",
  created: "2026-06-24T08:00:00Z",
  updated: "2026-06-24T09:00:00Z",
};

const TIMELINE_USER = {
  id: 213843,
  login: "example-user",
  login_name: "",
  source_id: 0,
  full_name: "",
  email: "1+example-user@noreply.gitea.com",
  avatar_url:
    "https://gitea.com/avatars/0000000000000000000000000000000000000000000000000000000000000000",
  html_url: "https://gitea.com/example-user",
  language: "",
  is_admin: false,
  last_login: "0001-01-01T00:00:00Z",
  created: "2026-06-27T18:29:03Z",
  restricted: false,
  active: false,
  prohibit_login: false,
  location: "",
  website: "",
  description: "",
  visibility: "public",
  followers_count: 0,
  following_count: 0,
  starred_repos_count: 0,
  username: "example-user",
};

// Shape of a `tea pr 1 -o json` response.
const TIMELINE_PR_VIEW = {
  id: 161481,
  index: 1,
  title: "Timeline fixture PR",
  state: "open",
  created: "2026-06-28T16:15:10Z",
  updated: "2026-06-28T16:16:18Z",
  labels: [],
  user: "example-user",
  body: "Sample pull request body.",
  assignees: [],
  url: "https://gitea.com/example-user/sample-repo/pulls/1",
  base: "main",
  head: "timeline-fixture",
  headSha: "5555555555555555555555555555555555555555",
  diffUrl: "https://gitea.com/example-user/sample-repo/pulls/1.diff",
  mergeable: true,
  hasMerged: false,
  mergedAt: null,
  closedAt: null,
  reviews: [
    {
      id: 2001,
      reviewer: "example-user",
      state: "COMMENT",
      body: "Timeline fixture general review comment.",
      created: "2026-06-28T16:15:28Z",
    },
    {
      id: 2002,
      reviewer: "example-user",
      state: "COMMENT",
      body: "Timeline fixture inline review.",
      created: "2026-06-28T16:16:18Z",
    },
  ],
  comments: [],
};

// `tea api repos/:owner/:repo/issues/:index/comments` shape.
const TIMELINE_ISSUE_COMMENTS = [
  {
    id: 1001,
    html_url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1001",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
    issue_url: "",
    user: TIMELINE_USER,
    original_author: "",
    original_author_id: 0,
    body: "Timeline fixture issue comment from tea api.",
    assets: [],
    created_at: "2026-06-28T16:15:18Z",
    updated_at: "2026-06-28T16:15:18Z",
  },
];

function makeTimelineIssueComments(count: number, startId = 4000) {
  return Array.from({ length: count }, (_, index) => ({
    ...TIMELINE_ISSUE_COMMENTS[0],
    id: startId + index,
    html_url: `https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-${startId + index}`,
    body: `comment ${index}`,
  }));
}

// `tea api repos/:owner/:repo/pulls/:index/reviews` shape.
const TIMELINE_REVIEWS = [
  {
    id: 2001,
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    team: null,
    state: "COMMENT",
    body: "Timeline fixture general review comment.",
    commit_id: "5555555555555555555555555555555555555555",
    stale: false,
    official: false,
    dismissed: false,
    comments_count: 0,
    submitted_at: "2026-06-28T16:15:28Z",
    updated_at: "2026-06-28T16:15:28Z",
    html_url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1002",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
  {
    id: 2002,
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    team: null,
    state: "COMMENT",
    body: "Timeline fixture inline review.",
    commit_id: "5555555555555555555555555555555555555555",
    stale: false,
    official: false,
    dismissed: false,
    comments_count: 1,
    submitted_at: "2026-06-28T16:16:18Z",
    updated_at: "2026-06-28T16:16:18Z",
    html_url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1004",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
];

// `tea api repos/:owner/:repo/pulls/:index/reviews/:reviewId/comments` shape.
const TIMELINE_REVIEW_COMMENTS = [
  {
    id: 1003,
    body: "Timeline fixture inline review comment.",
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    resolver: null,
    pull_request_review_id: 2002,
    created_at: "2026-06-28T16:16:18Z",
    updated_at: "2026-06-28T16:16:18Z",
    path: "README.md",
    commit_id: "5555555555555555555555555555555555555555",
    original_commit_id: "",
    diff_hunk:
      "@@ -2,2 +2,3 @@\n-Sample timeline fixture\n\\ No newline at end of file\n+Sample timeline fixture.\n+",
    position: 4,
    original_position: 0,
    html_url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1003",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
];

const LOGINS = [
  { name: "gitea.com", url: "https://gitea.com", ssh_host: "gitea.com", user: "example-user" },
];

function giteaMergeStatus(
  overrides: Partial<PullRequestCommandStatus> = {},
): PullRequestCommandStatus {
  return {
    forgeSpecific: { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: "success" },
    ...overrides,
  };
}

describe("createGiteaService", () => {
  it("maps a tea pr list item to the neutral current PR status by head branch", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list")
        return ok(JSON.stringify([OPEN_PR, CONFLICTING_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status).toMatchObject({
      number: 5,
      url: "https://gitea.com/example-user/sample-repo/pulls/5",
      title: "Add sample feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      isMerged: false,
      mergeable: "MERGEABLE",
      checksStatus: "pending",
      reviewDecision: null,
      repoOwner: "example-user",
      repoName: "sample-repo",
      projectPath: "example-user/sample-repo",
    });
    expect(status?.checks).toEqual([
      {
        name: "ci/test",
        status: "success",
        url: "https://example.invalid/ci/test",
        checkRunId: 1,
      },
      {
        name: "ci/lint",
        status: "pending",
        url: "https://example.invalid/ci/lint",
        checkRunId: 2,
      },
    ]);
    expect(status?.forgeSpecific).toEqual({
      forge: "gitea",
      mergeable: true,
      hasMerged: false,
      ciStatus: "success",
    });
    // Requests the explicit field set; tea's default omits url/mergeable/base/head/ci.
    expect(calls[0]).toContain("--fields");
    expect(calls[0]).toContain("-o");
    expect(calls[0]).toContain("json");
    expect(calls[1]).toEqual(["pr", "5", "-o", "json"]);
    expect(calls[2]).toEqual([
      "api",
      "repos/example-user/sample-repo/commits/3333333333333333333333333333333333333333/status",
    ]);
  });

  it("maps Gitea combined commit status contexts to flat checks", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("pending");
    expect(status?.checks).toEqual([
      {
        name: "ci/test",
        status: "success",
        url: "https://example.invalid/ci/test",
        checkRunId: 1,
      },
      {
        name: "ci/lint",
        status: "pending",
        url: "https://example.invalid/ci/lint",
        checkRunId: 2,
      },
    ]);
  });

  it("maps matching Gitea Actions workflow runs to flat checks", async () => {
    const actionsHeadSha = "2222222222222222222222222222222222222222";
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") {
        return ok(JSON.stringify({ ...STATUS_PR_VIEW, headSha: actionsHeadSha }));
      }
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(JSON.stringify(SAMPLE_ACTIONS_TASKS));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("success");
    expect(status?.checks).toEqual([
      {
        name: "verify",
        status: "success",
        url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
        workflowRunId: 6979709,
      },
    ]);
  });

  it("keeps only the latest Gitea Actions rerun for the same workflow", async () => {
    const headSha = STATUS_PR_VIEW.headSha;
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 41,
                name: "verify",
                head_sha: headSha,
                run_number: 4,
                status: "failure",
                workflow_id: "ci.yml",
                url: "https://example.invalid/actions/runs/4",
                created_at: "2026-06-28T18:00:00+02:00",
              },
              {
                id: 42,
                name: "verify",
                head_sha: headSha,
                run_number: 5,
                status: "success",
                workflow_id: "ci.yml",
                url: "https://example.invalid/actions/runs/5",
                created_at: "2026-06-28T18:10:00+02:00",
              },
            ],
            total_count: 2,
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("success");
    expect(status?.checks).toEqual([
      {
        name: "verify",
        status: "success",
        url: "https://example.invalid/actions/runs/5",
        workflowRunId: 42,
      },
    ]);
  });

  it("reports failure when Actions fail even if the commit-status aggregate is success", async () => {
    const headSha = STATUS_PR_VIEW.headSha;
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(
          JSON.stringify({
            state: "success",
            total_count: 1,
            statuses: [SAMPLE_COMBINED_STATUS.statuses[0]],
          }),
        );
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 71,
                name: "e2e",
                head_sha: headSha,
                run_number: 3,
                status: "failure",
                workflow_id: "e2e.yml",
                url: "https://example.invalid/actions/runs/71",
                created_at: "2026-06-28T19:00:00+02:00",
              },
            ],
            total_count: 1,
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    // The commit-status combined state is "success", but a failed Actions run
    // must pull the aggregate to failure — never green on a failing PR.
    expect(status?.checksStatus).toBe("failure");
    expect(status?.checks.map((check) => check.status)).toContain("failure");
  });

  it("keeps separate Gitea Actions workflows for the same head SHA", async () => {
    const headSha = STATUS_PR_VIEW.headSha;
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 51,
                name: "verify",
                head_sha: headSha,
                run_number: 7,
                status: "success",
                workflow_id: "ci.yml",
                url: "https://example.invalid/actions/runs/7",
              },
              {
                id: 52,
                name: "release",
                head_sha: headSha,
                run_number: 3,
                status: "pending",
                workflow_id: "release.yml",
                url: "https://example.invalid/actions/runs/3",
              },
            ],
            total_count: 2,
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("pending");
    expect(status?.checks).toEqual([
      {
        name: "verify",
        status: "success",
        url: "https://example.invalid/actions/runs/7",
        workflowRunId: 51,
      },
      {
        name: "release",
        status: "pending",
        url: "https://example.invalid/actions/runs/3",
        workflowRunId: 52,
      },
    ]);
  });

  it("maps Gitea Actions run status values", async () => {
    const headSha = STATUS_PR_VIEW.headSha;
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 11,
                name: "success-run",
                head_sha: headSha,
                status: "success",
                workflow_id: "success.yml",
                url: "https://example.invalid/actions/runs/11",
              },
              {
                id: 12,
                name: "failure-run",
                head_sha: headSha,
                status: "failure",
                workflow_id: "failure.yml",
                url: "https://example.invalid/actions/runs/12",
              },
              {
                id: 13,
                name: "cancelled-run",
                head_sha: headSha,
                status: "cancelled",
                workflow_id: "cancelled.yml",
                url: "https://example.invalid/actions/runs/13",
              },
              {
                id: 14,
                name: "running-run",
                head_sha: headSha,
                status: "running",
                workflow_id: "running.yml",
                url: "https://example.invalid/actions/runs/14",
              },
              {
                id: 15,
                name: "pending-run",
                head_sha: headSha,
                status: "pending",
                workflow_id: "pending.yml",
                url: "https://example.invalid/actions/runs/15",
              },
              {
                id: 16,
                name: "skipped-run",
                head_sha: headSha,
                status: "skipped",
                workflow_id: "skipped.yml",
                url: "https://example.invalid/actions/runs/16",
              },
            ],
            total_count: 6,
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("failure");
    expect(status?.checks.map((check) => check.status)).toEqual([
      "success",
      "failure",
      "cancelled",
      "pending",
      "pending",
      "skipped",
    ]);
  });

  it("combines Gitea commit statuses with matching Actions runs", async () => {
    const headSha = STATUS_PR_VIEW.headSha;
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        return ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 6979709,
                name: "verify",
                head_sha: headSha,
                status: "success",
                workflow_id: "ci.yml",
                url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
              },
            ],
            total_count: 1,
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("pending");
    expect(status?.checks).toEqual([
      {
        name: "ci/test",
        status: "success",
        url: "https://example.invalid/ci/test",
        checkRunId: 1,
      },
      {
        name: "ci/lint",
        status: "pending",
        url: "https://example.invalid/ci/lint",
        checkRunId: 2,
      },
      {
        name: "verify",
        status: "success",
        url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
        workflowRunId: 6979709,
      },
    ]);
  });

  it.each([
    ["failure", "failure", "failure"],
    ["error", "error", "failure"],
    ["success", "success", "success"],
  ] as const)("maps Gitea commit status state %s", async (aggregate, state, expected) => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(
          JSON.stringify({
            ...SAMPLE_COMBINED_STATUS,
            state: aggregate,
            statuses: [{ ...SAMPLE_COMBINED_STATUS.statuses[0], status: state }],
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe(expected);
    expect(status?.checks[0]?.status).toBe(expected);
  });

  it("maps a Gitea 'warning' commit status to failure (terminal, non-passing), not stuck pending", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(
          JSON.stringify({
            ...SAMPLE_COMBINED_STATUS,
            state: "warning",
            statuses: [{ ...SAMPLE_COMBINED_STATUS.statuses[0], status: "warning" }],
          }),
        );
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    // Gitea's "warning" is terminal and non-passing (IsSuccess()===false, blocks
    // merge). Our enum has no yellow bucket, so it surfaces as failure — never
    // green success, never a never-resolving pending.
    expect(status?.checks[0]?.status).toBe("failure");
    expect(status?.checksStatus).toBe("failure");
  });

  it("falls back to the tea PR ci aggregate when combined status is empty", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "pending", statuses: [], total_count: 0 }));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checks).toEqual([]);
    expect(status?.checksStatus).toBe("success");
  });

  it("maps a tea PR ci aggregate of 'warning' to failure, not stuck pending", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list")
        return ok(JSON.stringify([{ ...OPEN_PR, ci: "warning" }]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "warning", statuses: [], total_count: 0 }));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checks).toEqual([]);
    expect(status?.checksStatus).toBe("failure");
  });

  it("falls back to the tea PR ci aggregate when combined status returns 404", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        throw { code: 1, stderr: "404 Not Found" };
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checks).toEqual([]);
    expect(status?.checksStatus).toBe("success");
  });

  it("falls back to commit statuses when Gitea Actions are unavailable", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
      }
      if (args[0] === "api" && args[1].includes("/actions/tasks")) {
        throw { code: 1, stderr: "404 Not Found" };
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status?.checksStatus).toBe("pending");
    expect(status?.checks).toEqual([
      {
        name: "ci/test",
        status: "success",
        url: "https://example.invalid/ci/test",
        checkRunId: 1,
      },
      {
        name: "ci/lint",
        status: "pending",
        url: "https://example.invalid/ci/lint",
        checkRunId: 2,
      },
    ]);
  });

  it("returns flat Gitea check details from a commit status entry", async () => {
    const localHeadSha = "1111111111111111111111111111111111111111";
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
        if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
        if (
          args[0] === "api" &&
          args[1] === `repos/example-user/sample-repo/commits/${STATUS_PR_VIEW.headSha}/status`
        ) {
          return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
        }
        if (
          args[0] === "api" &&
          args[1] === `repos/example-user/sample-repo/commits/${localHeadSha}/status`
        ) {
          return ok(JSON.stringify({ state: "success", statuses: [], total_count: 0 }));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      {
        resolveCurrentBranch: async () => "feat/sample-change",
      },
    );

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      checkRunId: 2,
    });

    expect(details).toEqual({
      checkRunId: 2,
      name: "ci/lint",
      status: "pending",
      conclusion: "pending",
      url: "https://example.invalid/ci/lint",
      detailsUrl: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/statuses/3333333333333333333333333333333333333333`,
      output: {
        title: "ci/lint",
        summary: "Lint running",
        text: null,
      },
      annotations: [],
      failedJobs: [],
      truncated: false,
    });
    expect(calls).toEqual([
      [
        "pr",
        "list",
        "--fields",
        "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci",
        "--state",
        "open",
        "-o",
        "json",
        "--limit",
        "50",
        "--page",
        "1",
      ],
      ["pr", "5", "-o", "json"],
      ["api", `repos/example-user/sample-repo/commits/${STATUS_PR_VIEW.headSha}/status`],
    ]);
  });

  it("resolves terminal PR check details by explicit change request number", async () => {
    const headSha = "8888888888888888888888888888888888888888";
    const terminalView = {
      ...STATUS_PR_VIEW,
      index: 8,
      state: "closed",
      head: "feat/recently-closed",
      headSha,
      hasMerged: true,
      mergedAt: "2026-06-28T17:00:00Z",
    };
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "8") return ok(JSON.stringify(terminalView));
        if (args[0] === "api" && args[1].endsWith(`/commits/${headSha}/status`)) {
          return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      { resolveCurrentBranch: async () => "feat/recently-closed" },
    );

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      checkRunId: 2,
      changeRequestNumber: 8,
    });

    expect(details).toMatchObject({ checkRunId: 2, name: "ci/lint", status: "pending" });
    expect(calls).toEqual([
      ["pr", "8", "-o", "json"],
      ["api", `repos/example-user/sample-repo/commits/${headSha}/status`],
    ]);
  });

  it("resolves Gitea Actions check details addressed only by workflowRunId", async () => {
    const { service } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
        if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
        if (args[0] === "api" && args[1].endsWith("/status")) {
          return ok(JSON.stringify({ state: "success", statuses: [], total_count: 0 }));
        }
        if (args[0] === "api" && args[1].includes("/actions/tasks")) {
          return ok(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 7001,
                  name: "e2e",
                  head_sha: STATUS_PR_VIEW.headSha,
                  run_number: 3,
                  status: "failure",
                  workflow_id: "e2e.yml",
                  url: "https://gitea.com/example-user/sample-repo/actions/runs/7001",
                },
              ],
              total_count: 1,
            }),
          );
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      { resolveCurrentBranch: async () => "feat/sample-change" },
    );

    // No checkRunId — only the Actions workflowRunId, as the PR pane sends for a
    // Gitea Actions row. It must still resolve instead of throwing.
    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      workflowRunId: 7001,
    });

    expect(details).toMatchObject({
      workflowRunId: 7001,
      name: "e2e",
      conclusion: "failure",
      url: "https://gitea.com/example-user/sample-repo/actions/runs/7001",
    });
  });

  it("caches the resolved PR head SHA across polls within the TTL", async () => {
    let currentTime = 0;
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
        if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
        if (
          args[0] === "api" &&
          args[1] === `repos/example-user/sample-repo/commits/${STATUS_PR_VIEW.headSha}/status`
        ) {
          return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      {
        resolveCurrentBranch: async () => "feat/sample-change",
        now: () => currentTime,
      },
    );
    const request = {
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      checkRunId: 2,
    };

    await service.getCheckDetails(request);
    const prLookupCallsAfterFirstPoll = calls.filter((args) => args[0] === "pr").length;

    currentTime += 5_000;
    await service.getCheckDetails(request);

    expect(calls.filter((args) => args[0] === "pr").length).toBe(prLookupCallsAfterFirstPoll);
  });

  it("re-resolves the PR head SHA once the cache TTL expires", async () => {
    let currentTime = 0;
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
        if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
        if (
          args[0] === "api" &&
          args[1] === `repos/example-user/sample-repo/commits/${STATUS_PR_VIEW.headSha}/status`
        ) {
          return ok(JSON.stringify(SAMPLE_COMBINED_STATUS));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      {
        resolveCurrentBranch: async () => "feat/sample-change",
        now: () => currentTime,
      },
    );
    const request = {
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      checkRunId: 2,
    };

    await service.getCheckDetails(request);
    const prLookupCallsAfterFirstPoll = calls.filter((args) => args[0] === "pr").length;

    currentTime += 60_000;
    await service.getCheckDetails(request);

    expect(calls.filter((args) => args[0] === "pr").length).toBeGreaterThan(
      prLookupCallsAfterFirstPoll,
    );
  });

  it("throws when check details cannot find a PR for the current branch", async () => {
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([]));
        if (args[0] === "api" && args[1].includes("/pulls?state=all")) {
          return ok(JSON.stringify([]));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      {
        resolveCurrentBranch: async () => "feat/nonexistent",
      },
    );

    await expect(
      service.getCheckDetails({
        cwd: "/repo",
        repoOwner: "example-user",
        repoName: "sample-repo",
        checkRunId: 2,
      }),
    ).rejects.toThrow("Gitea pull request for branch feat/nonexistent was not found");
    expect(calls[1]).toEqual([
      "api",
      "repos/example-user/sample-repo/pulls?state=all&sort=recentupdate&page=1&limit=50",
    ]);
  });

  it("throws when check details address neither a checkRunId nor a workflowRunId", async () => {
    const { service, calls } = makeService(() => {
      throw new Error("no CLI call expected for an unaddressable check details request");
    });

    await expect(
      service.getCheckDetails({
        cwd: "/repo",
        repoOwner: "example-user",
        repoName: "sample-repo",
      }),
    ).rejects.toThrow("requires a checkRunId or workflowRunId");
    expect(calls).toEqual([]);
  });

  it("returns flat Gitea check details from an Actions workflow run", async () => {
    const actionsHeadSha = "2222222222222222222222222222222222222222";
    const { service } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([OPEN_PR]));
        if (args[0] === "pr" && args[1] === "5") {
          return ok(JSON.stringify({ ...STATUS_PR_VIEW, headSha: actionsHeadSha }));
        }
        if (args[0] === "api" && args[1].includes("/commits/")) {
          return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
        }
        if (args[0] === "api" && args[1].includes("/actions/tasks")) {
          return ok(JSON.stringify(SAMPLE_ACTIONS_TASKS));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      {
        resolveCurrentBranch: async () => "feat/sample-change",
      },
    );

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "example-user",
      repoName: "sample-repo",
      checkRunId: 6979709,
      workflowRunId: 6979709,
    });

    expect(details).toEqual({
      checkRunId: 6979709,
      workflowRunId: 6979709,
      name: "verify",
      status: "success",
      conclusion: "success",
      url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
      detailsUrl: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
      output: {
        title: "chore: add MIT license",
        summary: "ci.yml",
        text: null,
      },
      annotations: [],
      failedJobs: [],
      truncated: false,
    });
  });

  it("keeps the commit-statuses endpoint shape as a fixture", () => {
    expect(SAMPLE_COMMIT_STATUSES).toEqual([
      {
        id: 2,
        status: "pending",
        target_url: "https://example.invalid/ci/lint",
        description: "Lint running",
        url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/statuses/3333333333333333333333333333333333333333`,
        context: "ci/lint",
        creator: STATUS_CREATOR,
        created_at: "2026-06-28T16:25:04Z",
        updated_at: "2026-06-28T16:25:04Z",
      },
      {
        id: 1,
        status: "success",
        target_url: "https://example.invalid/ci/test",
        description: "Tests passed",
        url: `https://gitea.com/api/v1/repos/example-user/${SAMPLE_STATUS_REPO}/statuses/3333333333333333333333333333333333333333`,
        context: "ci/test",
        creator: STATUS_CREATOR,
        created_at: "2026-06-28T16:25:03Z",
        updated_at: "2026-06-28T16:25:03Z",
      },
    ]);
  });

  it("keeps the Codeberg Actions tasks endpoint shape as a fixture", () => {
    expect(SAMPLE_ACTIONS_TASKS).toEqual({
      workflow_runs: [
        {
          id: 6979709,
          name: "verify",
          head_branch: "main",
          head_sha: "2222222222222222222222222222222222222222",
          run_number: 3,
          event: "push",
          display_title: "chore: add MIT license",
          status: "success",
          workflow_id: "ci.yml",
          url: "https://codeberg.org/example-user/sample-repo/actions/runs/3",
          created_at: "2026-06-28T18:48:20+02:00",
          updated_at: "2026-06-28T18:48:38+02:00",
          run_started_at: "2026-06-28T18:48:20+02:00",
        },
        {
          id: 6979634,
          name: "verify",
          head_branch: "main",
          head_sha: "4444444444444444444444444444444444444444",
          run_number: 2,
          event: "push",
          display_title: "ci: trigger run",
          status: "success",
          workflow_id: "ci.yml",
          url: "https://codeberg.org/example-user/sample-repo/actions/runs/2",
          created_at: "2026-06-28T18:43:50+02:00",
          updated_at: "2026-06-28T18:44:06+02:00",
          run_started_at: "2026-06-28T18:43:50+02:00",
        },
      ],
      total_count: 2,
    });
  });

  it("reports a conflicting PR as CONFLICTING with a failing CI", async () => {
    const { service } = makeService(() => ok(JSON.stringify([CONFLICTING_PR])));

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/conflict",
    });

    expect(status?.mergeable).toBe("CONFLICTING");
    expect(status?.checksStatus).toBe("failure");
  });

  it("finds the open current-branch PR even when its remote head SHA differs", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...OPEN_PR,
      index: String(100 + index),
      url: `https://gitea.com/example-user/sample-repo/pulls/${100 + index}`,
      head: `feat/other-${index}`,
    }));
    const secondPage = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...OPEN_PR,
        index: String(200 + index),
        url: `https://gitea.com/example-user/sample-repo/pulls/${200 + index}`,
        head: `feat/later-${index}`,
      })),
      OPEN_PR,
    ];
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list" && argValue(args, "--state") === "open") {
        return ok(JSON.stringify(argValue(args, "--page") === "2" ? secondPage : firstPage));
      }
      if (args[0] === "pr" && args[1] === "5") return ok(JSON.stringify(STATUS_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/commits/")) {
        return ok(JSON.stringify({ state: "", statuses: [], total_count: 0 }));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
      headSha: "9999999999999999999999999999999999999999",
    });

    expect(status?.number).toBe(5);
    expect(
      calls
        .filter((args) => args[0] === "pr" && args[1] === "list")
        .map((args) => [argValue(args, "--state"), argValue(args, "--page")]),
    ).toEqual([
      ["open", "1"],
      ["open", "2"],
    ]);
  });

  it("falls back to the recent all-state PR window for a recently closed current branch PR", async () => {
    const headSha = "8888888888888888888888888888888888888888";
    const closedPr = currentPullRequestApi({
      number: 8,
      state: "closed",
      headRef: "feat/recently-closed",
      headSha,
    });
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list" && argValue(args, "--state") === "open") {
        return ok(JSON.stringify([]));
      }
      if (args[0] === "api" && args[1].includes("/pulls?state=all")) {
        return ok(JSON.stringify([closedPr]));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/recently-closed",
      headSha,
    });

    expect(status).toMatchObject({ number: 8, headRefName: "feat/recently-closed" });
    expect(calls[1]).toEqual([
      "api",
      "repos/example-user/sample-repo/pulls?state=all&sort=recentupdate&page=1&limit=50",
    ]);
  });

  it("uses tea repository context when origin identity is unavailable", async () => {
    const headSha = "8888888888888888888888888888888888888888";
    const closedPr = currentPullRequestApi({
      number: 8,
      state: "closed",
      headRef: "feat/recently-closed",
      headSha,
    });
    const { service, calls } = makeService(
      (args) => {
        if (args[0] === "pr" && args[1] === "list") return ok("[]");
        if (args[0] === "api" && args[1].startsWith("repos/{owner}/{repo}/pulls?")) {
          return ok(JSON.stringify([closedPr]));
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      { resolveRemoteUrl: async () => null },
    );

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/recently-closed",
      headSha,
    });

    expect(status).toMatchObject({ number: 8, headRefName: "feat/recently-closed" });
    expect(calls[1]).toEqual([
      "api",
      "repos/{owner}/{repo}/pulls?state=all&sort=recentupdate&page=1&limit=50",
    ]);
  });

  it("does not attach a stale Gitea-family PR after a same-name branch advances", async () => {
    const stale = currentPullRequestApi({
      number: 8,
      state: "closed",
      headRef: "dev",
      headSha: "1111111111111111111111111111111111111111",
      merged: true,
    });
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok("[]");
      if (args[0] === "api" && args[1].includes("/pulls?state=all")) {
        return ok(JSON.stringify([stale]));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "dev",
        headSha: "2222222222222222222222222222222222222222",
      }),
    ).resolves.toBeNull();
  });

  it("returns null when no PR matches the current branch", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([]));
      if (args[0] === "api" && args[1].includes("/pulls?state=all")) {
        return ok(JSON.stringify([]));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/nonexistent",
    });

    expect(status).toBeNull();
    expect(calls[1]).toEqual([
      "api",
      "repos/example-user/sample-repo/pulls?state=all&sort=recentupdate&page=1&limit=50",
    ]);
  });

  it("lists open pull requests", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_PR])));

    const prs = await service.listPullRequests({ cwd: "/repo" });

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 5,
      title: "Add sample feature",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      labels: ["enhancement", "review"],
      state: "open",
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "list", "--state", "open", "-o", "json"]),
    );
  });

  it("resolves the tea CLI path once per service instance, not per invocation", async () => {
    let resolveCalls = 0;
    const { service } = makeService(() => ok(JSON.stringify([OPEN_PR])), {
      resolveTeaPath: async () => {
        resolveCalls += 1;
        return "/usr/bin/tea";
      },
    });

    await service.listPullRequests({ cwd: "/repo" });
    await service.listPullRequests({ cwd: "/repo" });

    expect(resolveCalls).toBe(1);
  });

  it("lists issues", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_ISSUE])));

    const issues = await service.listIssues({ cwd: "/repo" });

    expect(issues[0]).toMatchObject({
      number: 3,
      title: "Login button misaligned",
      url: "https://gitea.com/example-user/sample-repo/issues/3",
      labels: ["bug"],
      state: "open",
    });
    expect(calls[0]).toEqual([
      "issue",
      "list",
      "--fields",
      "index,state,author,url,title,body,labels,comments,created,updated",
      "--state",
      "open",
      "-o",
      "json",
    ]);
  });

  it("fetches a single pull request by number", async () => {
    const { service, calls } = makeService(() =>
      ok(
        JSON.stringify({
          index: 6,
          url: "https://gitea.com/example-user/sample-repo/pulls/6",
          state: "open",
          title: "Fix conflict",
          base: "main",
          head: "feat/conflict",
          mergeable: false,
          hasMerged: false,
        }),
      ),
    );

    const pr = await service.getPullRequest({ cwd: "/repo", number: 6 });

    expect(pr.number).toBe(6);
    expect(pr.headRefName).toBe("feat/conflict");
    // Fetched by number directly, not by scanning the recent-PR list.
    expect(calls).toContainEqual(["pr", "6", "-o", "json"]);
  });

  it("maps a same-repo pull request to a checkout target", async () => {
    const { service } = makeService((args) =>
      args[0] === "api"
        ? ok(JSON.stringify({ head: { repo: { id: 1 } }, base: { repo: { id: 1 } } }))
        : ok(JSON.stringify(STATUS_PR_VIEW)),
    );

    await expect(
      service.getPullRequestCheckoutTarget({ cwd: "/repo", number: 5 }),
    ).resolves.toEqual({
      number: 5,
      baseRefName: "main",
      headRefName: "feat/sample-change",
      checkoutRefs: [
        { remoteName: "origin", remoteRef: "refs/pull/5/head" },
        { remoteName: "origin", remoteRef: "refs/heads/feat/sample-change" },
      ],
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    });
  });

  it("maps a fork pull request to a cross-repository checkout target", async () => {
    const { service, calls } = makeService((args) =>
      args[0] === "api"
        ? ok(
            JSON.stringify({
              head: {
                repo: {
                  id: 2,
                  owner: { login: "contributor" },
                  ssh_url: "git@gitea.com:contributor/sample-repo.git",
                  html_url: "https://gitea.com/contributor/sample-repo",
                },
              },
              base: { repo: { id: 1 } },
            }),
          )
        : ok(JSON.stringify(STATUS_PR_VIEW)),
    );

    await expect(
      service.getPullRequestCheckoutTarget({ cwd: "/repo", number: 5 }),
    ).resolves.toEqual({
      number: 5,
      baseRefName: "main",
      headRefName: "feat/sample-change",
      checkoutRefs: [
        { remoteName: "origin", remoteRef: "refs/pull/5/head" },
        { remoteName: "origin", remoteRef: "refs/heads/feat/sample-change" },
      ],
      headOwnerLogin: "contributor",
      headRepositorySshUrl: "git@gitea.com:contributor/sample-repo.git",
      headRepositoryUrl: "https://gitea.com/contributor/sample-repo",
      isCrossRepository: true,
    });

    expect(calls).toContainEqual(["api", "repos/example-user/sample-repo/pulls/5"]);
  });

  it("creates a pull request and parses the resulting URL and index", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return ok("Created #7\nhttps://gitea.com/example-user/sample-repo/pulls/7");
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const result = await service.createPullRequest({
      cwd: "/repo",
      repo: "example-user/sample-repo",
      title: "New feature",
      head: "feat/new",
      base: "main",
      body: "Body",
    });

    expect(result).toEqual({
      url: "https://gitea.com/example-user/sample-repo/pulls/7",
      number: 7,
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "create", "--head", "feat/new", "--base", "main"]),
    );
  });

  it("merges a mergeable pull request with the requested style", async () => {
    const { service, calls } = makeService(() => ok(""));

    const result = await service.mergePullRequest({
      cwd: "/repo",
      prNumber: 5,
      mergeMethod: "squash",
      status: giteaMergeStatus(),
    });

    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual(["pr", "merge", "5", "--style", "squash"]);
  });

  it("refuses to merge a pull request Gitea does not report as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));

    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 6,
        mergeMethod: "merge",
        status: giteaMergeStatus({
          forgeSpecific: {
            forge: "gitea",
            mergeable: false,
            hasMerged: false,
            ciStatus: "failure",
          },
        }),
      }),
    ).rejects.toThrow(/ready for direct merge/);
    expect(calls).toHaveLength(0);
  });

  it("maps Gitea PR comments and reviews to a neutral timeline", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(TIMELINE_REVIEWS));
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(TIMELINE_REVIEW_COMMENTS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toEqual([
      ["pr", "1", "-o", "json"],
      ["api", "repos/example-user/sample-repo/issues/1/comments?page=1&limit=50"],
      ["api", "repos/example-user/sample-repo/pulls/1/reviews?page=1&limit=50"],
      ["api", "repos/example-user/sample-repo/pulls/1/reviews/2002/comments?page=1&limit=50"],
    ]);
    expect(timeline.error).toBeNull();
    expect(timeline.truncated).toBe(false);
    expect(timeline.items.map((item) => item.id)).toEqual(["1001", "2001", "1003", "2002"]);
    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      author: "example-user",
      authorUrl: "https://gitea.com/example-user",
      avatarUrl:
        "https://gitea.com/avatars/0000000000000000000000000000000000000000000000000000000000000000",
      body: "Timeline fixture issue comment from tea api.",
      createdAt: Date.parse("2026-06-28T16:15:18Z"),
      url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1001",
    });
    expect(timeline.items[1]).toMatchObject({
      kind: "review",
      id: "2001",
      reviewState: "commented",
      body: "Timeline fixture general review comment.",
    });
    expect(timeline.items[2]).toMatchObject({
      kind: "comment",
      id: "1003",
      reviewId: "2002",
      location: { path: "README.md", line: 4, threadId: "README.md#pos-4" },
    });
  });

  it("keeps distinct inline locations in separate threads within one review", async () => {
    const reviews = [{ ...TIMELINE_REVIEWS[1], id: 2002, comments_count: 3 }];
    // One review, three inline comments: two share a location (a reply chain),
    // the third sits on a different line. All carry the same review id.
    const reviewComments = [
      { ...TIMELINE_REVIEW_COMMENTS[0], id: 3001, path: "README.md", position: 4 },
      { ...TIMELINE_REVIEW_COMMENTS[0], id: 3002, path: "README.md", position: 4 },
      { ...TIMELINE_REVIEW_COMMENTS[0], id: 3003, path: "README.md", position: 9 },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify([]));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(reviewComments));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    const threadIds = new Map(
      timeline.items
        .map(locatedCommentThreadId)
        .filter((entry): entry is [string, string | undefined] => entry !== null),
    );
    // Same location means same thread (reply chain); different line means different thread.
    expect(threadIds.get("3001")).toBe("README.md#pos-4");
    expect(threadIds.get("3002")).toBe("README.md#pos-4");
    expect(threadIds.get("3003")).toBe("README.md#pos-9");
    expect(threadIds.get("3003")).not.toBe(threadIds.get("3001"));
  });

  it("maps the Gitea review-comment resolver into location.isResolved", async () => {
    const reviews = [{ ...TIMELINE_REVIEWS[1], id: 2002, comments_count: 3 }];
    // One inline comment per resolution state: resolved (resolver is a user),
    // unresolved (resolver explicitly null), and unknown (resolver field absent).
    const withoutResolver: Record<string, unknown> = { ...TIMELINE_REVIEW_COMMENTS[0], id: 3103 };
    delete withoutResolver.resolver;
    const reviewComments = [
      { ...TIMELINE_REVIEW_COMMENTS[0], id: 3101, resolver: { ...TIMELINE_USER } },
      { ...TIMELINE_REVIEW_COMMENTS[0], id: 3102, resolver: null },
      withoutResolver,
    ];
    const { service } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify([]));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(reviewComments));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    const locations = new Map(
      timeline.items
        .filter((item) => item.kind === "comment" && item.location)
        .map((item) => [item.id, item.kind === "comment" ? item.location : undefined]),
    );
    expect(locations.get("3101")).toMatchObject({ isResolved: true });
    expect(locations.get("3102")).toMatchObject({ isResolved: false });
    expect(locations.get("3103")).toBeDefined();
    expect(locations.get("3103")).not.toHaveProperty("isResolved");
  });

  it("bounds concurrent review-comment fetches during the timeline fan-out", async () => {
    const reviewCount = 12;
    const reviews = Array.from({ length: reviewCount }, (_, index) => ({
      ...TIMELINE_REVIEWS[0],
      id: 5000 + index,
      comments_count: 1,
    }));
    let inFlight = 0;
    let maxInFlight = 0;

    const { service } = makeService(async (args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify([]));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      if (args[0] === "api" && args[1].includes("/comments")) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return ok(JSON.stringify([]));
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("keeps issue comments when the Gitea reviews endpoint fails", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        throw { code: 1, stderr: "404 reviews endpoint not found" };
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toHaveLength(3);
    expect(timeline).toMatchObject({
      error: null,
      truncated: false,
      items: [
        {
          kind: "comment",
          id: "1001",
          body: "Timeline fixture issue comment from tea api.",
        },
      ],
    });
  });

  it("keeps review summaries and other comments when one inline review comment fetch fails", async () => {
    const reviews = TIMELINE_REVIEWS.map((review) => ({ ...review, comments_count: 1 }));
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      if (args[0] === "api" && args[1].includes("/reviews/2001/comments"))
        throw { code: 1, stderr: "500 failed to fetch inline comments" };
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(TIMELINE_REVIEW_COMMENTS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toHaveLength(5);
    expect(timeline.error).toBeNull();
    expect(timeline.items.map((item) => item.id)).toEqual(["1001", "2001", "1003", "2002"]);
    expect(timeline.items).toContainEqual(
      expect.objectContaining({
        kind: "comment",
        id: "1003",
        reviewId: "2002",
      }),
    );
  });

  it("fetches a second Gitea comments page when the first page is full", async () => {
    const firstPage = makeTimelineIssueComments(50, 4000);
    const secondPage = makeTimelineIssueComments(10, 4050);
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments?page=1"))
        return ok(JSON.stringify(firstPage));
      if (args[0] === "api" && args[1].includes("/issues/1/comments?page=2"))
        return ok(JSON.stringify(secondPage));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok(JSON.stringify([]));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(
      calls.filter((call) => call[1]?.includes("/issues/1/comments?")).map((call) => call[1]),
    ).toEqual([
      "repos/example-user/sample-repo/issues/1/comments?page=1&limit=50",
      "repos/example-user/sample-repo/issues/1/comments?page=2&limit=50",
    ]);
    expect(timeline.items).toHaveLength(60);
    expect(timeline.truncated).toBe(false);
  });

  it("flags Gitea timeline truncation after the bounded comments page count", async () => {
    const fullPage = makeTimelineIssueComments(50, 5000);
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(fullPage));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok(JSON.stringify([]));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(
      calls.filter((call) => call[1]?.includes("/issues/1/comments?")).map((call) => call[1]),
    ).toEqual([
      "repos/example-user/sample-repo/issues/1/comments?page=1&limit=50",
      "repos/example-user/sample-repo/issues/1/comments?page=2&limit=50",
      "repos/example-user/sample-repo/issues/1/comments?page=3&limit=50",
      "repos/example-user/sample-repo/issues/1/comments?page=4&limit=50",
    ]);
    expect(timeline.items).toHaveLength(200);
    expect(timeline.truncated).toBe(true);
  });

  it("uses a single Gitea timeline fetch for a short comments page", async () => {
    const comments = makeTimelineIssueComments(3, 6000);
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(comments));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok(JSON.stringify([]));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(
      calls.filter((call) => call[1]?.includes("/issues/1/comments?")).map((call) => call[1]),
    ).toEqual(["repos/example-user/sample-repo/issues/1/comments?page=1&limit=50"]);
    expect(timeline.items).toHaveLength(3);
    expect(timeline.truncated).toBe(false);
  });

  it("maps Gitea review verdict states", async () => {
    const reviews = [
      { ...TIMELINE_REVIEWS[0], id: 1, state: "APPROVED", body: "approved", comments_count: 0 },
      {
        ...TIMELINE_REVIEWS[1],
        id: 2,
        state: "REQUEST_CHANGES",
        body: "needs work",
        comments_count: 0,
      },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments")) return ok("[]");
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline.items).toMatchObject([
      { kind: "review", id: "1", reviewState: "approved" },
      { kind: "review", id: "2", reviewState: "changes_requested" },
    ]);
  });

  it("drops Gitea system comments from the neutral timeline", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify([{ ...TIMELINE_ISSUE_COMMENTS[0], type: "pull_ref" }]));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok("[]");
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline.items).toEqual([]);
  });

  it.each([
    ["404 pull request not found", "not_found"],
    ["403 Forbidden", "forbidden"],
    ["401 Unauthorized", "forbidden"],
  ] as const)("returns a neutral %s timeline error", async (stderr, kind) => {
    const { service } = makeService(() => {
      throw { code: 1, stderr };
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 99,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline).toMatchObject({
      prNumber: 99,
      repoOwner: "example-user",
      repoName: "sample-repo",
      items: [],
      truncated: false,
      error: { kind },
    });
  });

  it("reports authenticated when a tea login matches the remote host", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "login" && args[1] === "list") return ok(JSON.stringify(LOGINS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(true);
  });

  it("reports unauthenticated when no tea login matches the remote host", async () => {
    const { service } = makeService(
      (args) => {
        if (args[0] === "login" && args[1] === "list") return ok(JSON.stringify(LOGINS));
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      { resolveRemoteUrl: async () => "https://git.other.example/team/repo.git" },
    );

    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
  });

  it("maps an authentication failure from tea onto TeaAuthenticationError", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toBeInstanceOf(
      TeaAuthenticationError,
    );
  });

  it("searches issues and pull requests and maps them to neutral results", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([OPEN_ISSUE]));
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "", limit: 10 });

    expect(result.githubFeaturesEnabled).toBe(true);
    expect(result.items).toEqual([
      {
        kind: "change_request",
        number: 5,
        title: "Add sample feature",
        url: "https://gitea.com/example-user/sample-repo/pulls/5",
        state: "open",
        body: "Implements the sample feature",
        labels: ["enhancement", "review"],
        projectPath: "example-user/sample-repo",
        baseRefName: "main",
        headRefName: "feat/sample-change",
        updatedAt: "2026-06-26T10:00:00Z",
      },
      {
        kind: "issue",
        number: 3,
        title: "Login button misaligned",
        url: "https://gitea.com/example-user/sample-repo/issues/3",
        state: "open",
        body: "On mobile the button overflows",
        labels: ["bug"],
        projectPath: "example-user/sample-repo",
        baseRefName: null,
        headRefName: null,
        updatedAt: "2026-06-24T09:00:00Z",
      },
    ]);

    expect(calls.find((args) => args[0] === "issue")).toEqual([
      "issue",
      "list",
      "--fields",
      "index,state,author,url,title,body,labels,comments,created,updated",
      "--state",
      "open",
      "-o",
      "json",
      "--limit",
      "10",
    ]);
    expect(calls.find((args) => args[0] === "pr")).toEqual([
      "pr",
      "list",
      "--fields",
      "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci",
      "--state",
      "open",
      "-o",
      "json",
      "--limit",
      "10",
    ]);
  });

  it("sorts issue and pull request search results by update time", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([OPEN_ISSUE]));
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "" });

    expect(result).toEqual({
      featuresEnabled: true,
      authState: "authenticated",
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "change_request",
          number: 5,
          title: "Add sample feature",
          url: "https://gitea.com/example-user/sample-repo/pulls/5",
          state: "open",
          body: "Implements the sample feature",
          labels: ["enhancement", "review"],
          projectPath: "example-user/sample-repo",
          baseRefName: "main",
          headRefName: "feat/sample-change",
          updatedAt: "2026-06-26T10:00:00Z",
        },
        {
          kind: "issue",
          number: 3,
          title: "Login button misaligned",
          url: "https://gitea.com/example-user/sample-repo/issues/3",
          state: "open",
          body: "On mobile the button overflows",
          labels: ["bug"],
          projectPath: "example-user/sample-repo",
          baseRefName: null,
          headRefName: null,
          updatedAt: "2026-06-24T09:00:00Z",
        },
      ],
    });
  });

  it("restricts search to pull requests when only the PR kind is requested", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "sample",
      kinds: ["github-pr"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "change_request", number: 5 });
    expect(calls).toEqual([
      [
        "pr",
        "list",
        "--fields",
        "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci",
        "--state",
        "open",
        "-o",
        "json",
      ],
    ]);
  });

  it("reports forge features disabled when tea is unavailable or unauthenticated", async () => {
    const missing = makeService(() => ok("[]"), { resolveTeaPath: async () => null }).service;
    await expect(missing.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual({
      items: [],
      featuresEnabled: false,
      authState: "cli_missing",
      githubFeaturesEnabled: false,
    });

    const unauthenticated = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    }).service;
    await expect(unauthenticated.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual(
      {
        items: [],
        featuresEnabled: false,
        authState: "unauthenticated",
        githubFeaturesEnabled: false,
      },
    );
  });

  it("rejects search when one requested kind fails for a non-auth reason", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "issue") {
        throw { code: 1, stderr: "temporary Gitea API failure" };
      }
      return ok(JSON.stringify([OPEN_PR]));
    });

    await expect(service.searchIssuesAndPrs({ cwd: "/repo", query: "sample" })).rejects.toThrow(
      TeaCommandError,
    );
  });
});

describe("detectGiteaFamilySoftware", () => {
  it("classifies a 404 Forgejo namespace from authenticated tea as gitea", async () => {
    const runTea = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "git.acme.it", url: "https://git.acme.it" }]),
          stderr: "",
        };
      }
      return { stdout: "Not found.", stderr: "HTTP/1.1 404 Not Found\nServer: Caddy\n" };
    };
    const software = await detectGiteaFamilySoftware("git.acme.it", {
      runTea,
    });
    expect(software).toBe("gitea");
  });

  it("reads forgejo from the authenticated tea status line when anonymous access is blocked", async () => {
    const runTea = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "forge.acme.it", url: "https://forge.acme.it" }]),
          stderr: "",
        };
      }
      return { stdout: '{"version":"1.0+gitea"}', stderr: "HTTP/1.1 200 OK\nServer: Caddy\n" };
    };
    const software = await detectGiteaFamilySoftware("forge.acme.it", {
      runTea,
    });
    expect(software).toBe("forgejo");
  });

  it("defaults to gitea when every tier is inconclusive", async () => {
    const software = await detectGiteaFamilySoftware("offline.example.com", {
      runTea: async () => ({ stdout: "[]", stderr: "" }),
    });
    expect(software).toBe("gitea");
  });
});
