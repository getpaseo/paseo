import { describe, expect, it } from "vitest";
import {
  buildPullRequestCheckContextAttachment,
  buildPullRequestCommentContextAttachment,
  buildPullRequestReviewContextAttachment,
  buildPullRequestThreadContextAttachment,
  canAddPullRequestActivityToChat,
  canAddPullRequestCheckLogsToChat,
  type PullRequestContextBuilderInput,
} from "./context-attachment";
import type { PrPaneActivity, PrPaneCheck } from "./data";
import type { PrThreadEntry } from "./timeline";

const baseInput: Omit<PullRequestContextBuilderInput, "activity"> = {
  provider: { id: "github", label: "GitHub" },
  pullRequest: {
    number: 42,
    title: "Fix flaky build",
    url: "https://github.com/getpaseo/paseo/pull/42",
  },
};

function comment(overrides: Partial<PrPaneActivity> = {}): PrPaneActivity {
  return {
    id: "comment-1",
    provider: "github",
    kind: "comment",
    author: "octocat",
    avatarColor: "#0ea5e9",
    body: "Looks good.",
    age: "3d ago",
    url: "https://github.com/getpaseo/paseo/pull/42#issuecomment-1",
    ...overrides,
  };
}

function review(overrides: Partial<PrPaneActivity> = {}): PrPaneActivity {
  return {
    id: "review-1",
    provider: "github",
    kind: "review",
    author: "reviewer",
    avatarColor: "#8b5cf6",
    reviewState: "commented",
    body: "Please simplify this.",
    age: "2d ago",
    url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
    ...overrides,
  };
}

function check(overrides: Partial<PrPaneCheck> = {}): PrPaneCheck {
  return {
    name: "server-tests",
    provider: "github",
    status: "failure",
    url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
    github: { checkRunId: 12345, workflowRunId: 456 },
    ...overrides,
  };
}

describe("pull request context attachments", () => {
  it("formats a comment as a workspace context attachment", () => {
    expect(
      buildPullRequestCommentContextAttachment({
        ...baseInput,
        activity: comment({
          location: {
            path: "packages/app/src/panel.tsx",
            line: 42,
            threadId: "PRRT_1",
            isResolved: false,
            isOutdated: true,
          },
        }),
      }),
    ).toEqual({
      kind: "github.pull_request_comment",
      id: "42:comment-1",
      title: "octocat",
      subtitle: "#42 Fix flaky build",
      url: "https://github.com/getpaseo/paseo/pull/42#issuecomment-1",
      text: [
        "GitHub pull request comment",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "URL: https://github.com/getpaseo/paseo/pull/42#issuecomment-1",
        "Author: octocat",
        "Created: 3d ago",
        "Location: packages/app/src/panel.tsx:42 · unresolved · outdated · thread PRRT_1",
        "",
        "Looks good.",
      ].join("\n"),
    });
  });

  it("formats a review with state as a workspace context attachment", () => {
    expect(buildPullRequestReviewContextAttachment({ ...baseInput, activity: review() })).toEqual({
      kind: "github.pull_request_review",
      id: "42:review-1",
      title: "reviewer",
      subtitle: "#42 Fix flaky build",
      url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
      text: [
        "GitHub pull request review",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "URL: https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
        "Author: reviewer",
        "State: commented",
        "Created: 2d ago",
        "",
        "Please simplify this.",
      ].join("\n"),
    });
  });

  it("does not add bodyless approvals to chat", () => {
    const activity = review({ reviewState: "approved", body: "" });

    expect(canAddPullRequestActivityToChat(activity)).toBe(false);
    expect(buildPullRequestReviewContextAttachment({ ...baseInput, activity })).toBeNull();
  });

  it("adds bodyless changes-requested reviews as metadata-only context", () => {
    const activity = review({ reviewState: "changes_requested", body: "" });

    expect(canAddPullRequestActivityToChat(activity)).toBe(true);
    expect(buildPullRequestReviewContextAttachment({ ...baseInput, activity })?.text).toBe(
      [
        "GitHub pull request review",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "URL: https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
        "Author: reviewer",
        "State: changes_requested",
        "Created: 2d ago",
      ].join("\n"),
    );
  });

  it("shows add-logs only for failed checks", () => {
    expect(canAddPullRequestCheckLogsToChat(check({ status: "failure" }))).toBe(true);
    expect(canAddPullRequestCheckLogsToChat(check({ status: "success" }))).toBe(false);
    expect(canAddPullRequestCheckLogsToChat(check({ status: "pending" }))).toBe(false);
    expect(canAddPullRequestCheckLogsToChat(check({ status: "skipped" }))).toBe(false);
  });

  it("formats failed check details as a workspace context attachment", () => {
    expect(
      buildPullRequestCheckContextAttachment({
        ...baseInput,
        check: check(),
        githubDetails: {
          checkRunId: 12345,
          workflowRunId: 456,
          name: "server-tests",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          output: { title: "Tests failed", summary: "1 failure", text: "Assertion failed" },
          annotations: [
            {
              path: "packages/server/src/index.ts",
              startLine: 10,
              endLine: 12,
              annotationLevel: "failure",
              message: "Expected true",
            },
          ],
          failedJobs: [
            {
              jobId: 789,
              name: "test",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
              logTail: "last line",
              logTruncated: false,
            },
          ],
          truncated: true,
        },
      }),
    ).toEqual({
      kind: "github.pull_request_check",
      id: "42:check-run:12345",
      title: "server-tests",
      subtitle: "#42 Fix flaky build",
      url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
      text: [
        "GitHub pull request check",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "Check: server-tests",
        "Status: failure",
        "Conclusion: failure",
        "Check URL: https://github.com/getpaseo/paseo/actions/runs/456/job/789",
        "Details URL: https://github.com/getpaseo/paseo/actions/runs/456/job/789",
        "Output title: Tests failed",
        "Output summary: 1 failure",
        "Output text:",
        "Assertion failed",
        "",
        "Annotations:",
        "- packages/server/src/index.ts:10-12 failure: Expected true",
        "",
        "Failed jobs:",
        "- test: failure",
        "  https://github.com/getpaseo/paseo/actions/runs/456/job/789",
        "  ```",
        "  last line",
        "  ```",
        "",
        "Note: Check details were truncated by GitHub/API or local caps.",
      ].join("\n"),
    });
  });

  it("keeps same-named GitHub checks distinct by check run", () => {
    const ubuntu = buildPullRequestCheckContextAttachment({
      ...baseInput,
      check: check({ github: { checkRunId: 12345, workflowRunId: 456 } }),
      githubDetails: null,
    });
    const windows = buildPullRequestCheckContextAttachment({
      ...baseInput,
      check: check({ github: { checkRunId: 67890, workflowRunId: 456 } }),
      githubDetails: null,
    });

    expect(ubuntu.id).toBe("42:check-run:12345");
    expect(windows.id).toBe("42:check-run:67890");
  });

  it("formats metadata-only failed check context when details are unavailable", () => {
    expect(
      buildPullRequestCheckContextAttachment({
        ...baseInput,
        check: check({
          name: "status/context",
          url: "https://github.com/getpaseo/paseo/status/context",
          github: undefined,
        }),
        githubDetails: null,
      }),
    ).toEqual({
      kind: "github.pull_request_check",
      id: "42:check:status/context",
      title: "status/context",
      subtitle: "#42 Fix flaky build",
      url: "https://github.com/getpaseo/paseo/status/context",
      text: [
        "GitHub pull request check",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "Check: status/context",
        "Status: failure",
        "Check URL: https://github.com/getpaseo/paseo/status/context",
      ].join("\n"),
    });
  });
});

describe("buildPullRequestThreadContextAttachment", () => {
  function thread(overrides: Partial<PrThreadEntry> = {}): PrThreadEntry {
    return {
      kind: "thread",
      id: "thread:PRRT_1",
      location: { path: "src/a.ts", line: 12, threadId: "PRRT_1", isResolved: false },
      comments: [
        comment({
          id: "t1",
          body: "This is frozen after initial registration.",
          url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
        }),
        comment({ id: "t2", author: "mo", age: "1d ago", body: "Good catch, fixing." }),
      ],
      ...overrides,
    };
  }

  it("bundles the whole thread conversation into one attachment", () => {
    expect(buildPullRequestThreadContextAttachment({ ...baseInput, thread: thread() })).toEqual({
      kind: "github.pull_request_comment",
      id: "42:thread:PRRT_1",
      title: "src/a.ts:12",
      subtitle: "#42 Fix flaky build",
      url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
      text: [
        "GitHub pull request review thread",
        "Pull request: #42 Fix flaky build",
        "Pull request URL: https://github.com/getpaseo/paseo/pull/42",
        "URL: https://github.com/getpaseo/paseo/pull/42#discussion_r1",
        "Location: src/a.ts:12",
        "Thread state: unresolved",
        "",
        "octocat (3d ago):\nThis is frozen after initial registration.",
        "",
        "---",
        "",
        "mo (1d ago):\nGood catch, fixing.",
      ].join("\n"),
    });
  });

  it("returns null when no comment has a body", () => {
    expect(
      buildPullRequestThreadContextAttachment({
        ...baseInput,
        thread: thread({ comments: [comment({ body: "  " })] }),
      }),
    ).toBeNull();
  });
});
