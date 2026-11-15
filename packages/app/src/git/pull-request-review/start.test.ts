import { beforeEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import {
  buildLocalChangesReviewPrompt,
  buildPullRequestReviewPrompt,
  type PullRequestReviewSubject,
} from "./context";
import { reviewFindingsInstructions } from "./findings";
import { reviewFindingsPath } from "./start";
import { startReviewChat } from "./start";

const pullRequest: PullRequestReviewSubject = {
  number: 42,
  title: "Add review chat",
  url: "https://github.com/getpaseo/paseo/pull/42",
  state: "open",
  forgeLabel: "GitHub",
  baseRef: "main",
  headRef: "feature/review",
};

const changedFile: ParsedDiffFile = {
  path: "src/app.ts",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 0,
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [{ type: "add", content: "export const ready = true;" }],
    },
  ],
};

const uploadedFile = {
  type: "uploaded_file" as const,
  id: "file-1",
  fileName: "pr-42-review-context.md",
  mimeType: "text/markdown",
  size: 10,
  path: "/tmp/pr-42-review-context.md",
};

function reviewClient(input?: { diffError?: string; uploadError?: string }): Pick<
  DaemonClient,
  "getCheckoutDiff" | "uploadFile"
> & {
  uploads: Array<{ fileName: string; mimeType: string; bytes: Uint8Array | ArrayBuffer }>;
  diffRequests: Array<Parameters<DaemonClient["getCheckoutDiff"]>[1]>;
} {
  const uploads: Array<{ fileName: string; mimeType: string; bytes: Uint8Array | ArrayBuffer }> =
    [];
  const diffRequests: Array<Parameters<DaemonClient["getCheckoutDiff"]>[1]> = [];
  return {
    uploads,
    diffRequests,
    getCheckoutDiff: async (_cwd, compare) => {
      diffRequests.push(compare);
      return {
        cwd: "/repo",
        files: input?.diffError ? [] : [changedFile],
        error: input?.diffError ? { code: "UNKNOWN" as const, message: input.diffError } : null,
        requestId: "diff-1",
      };
    },
    uploadFile: async (file) => {
      uploads.push(file);
      return {
        requestId: "upload-1",
        file: input?.uploadError ? null : { ...uploadedFile, size: file.bytes.byteLength },
        error: input?.uploadError ?? null,
      };
    },
  };
}

beforeEach(() => {
  useCreateFlowStore.getState().clearAll();
  useWorkspaceDraftSubmissionStore.setState({
    pendingByDraftId: {},
    setupByDraftId: {},
  });
  useDraftStore.setState({ drafts: {}, createModalDraft: null });
});

describe("startReviewChat", () => {
  it("starts a new chat with the review prompt and the context file", async () => {
    const client = reviewClient();
    const started = await startReviewChat({
      client,
      serverId: "server-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      subject: { kind: "pull_request", pullRequest },
      preferences: {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4",
            mode: "plan",
            thinkingByModel: { "gpt-5.4": "high" },
            options: { fast_mode: true },
          },
        },
      },
      draftId: "draft_review",
      now: 1_700_000_000_000,
    });

    expect(started).toEqual({
      draftId: "draft_review",
      submitted: true,
      target: {
        kind: "draft",
        draftId: "draft_review",
        setup: {
          provider: "codex",
          cwd: "/repo",
          modeId: "plan",
          model: "gpt-5.4",
          thinkingOptionId: "high",
          providerOptions: { fast_mode: true },
        },
      },
    });
    expect(client.uploads).toHaveLength(1);
    const upload = client.uploads[0];
    expect(upload?.fileName).toBe("pr-42-review-context.md");
    expect(upload?.mimeType).toBe("text/markdown");
    expect(new TextDecoder().decode(upload?.bytes)).toContain("### src/app.ts");
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId.draft_review).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-1",
      draftId: "draft_review",
      text: [
        "Review pull request #42: Add review chat",
        "https://github.com/getpaseo/paseo/pull/42",
        "",
        "Read the attached context file `pr-42-review-context.md`. It has the pull request metadata, the changed files, and the diff. This workspace is checked out on the pull request branch.",
        "",
        "Write a code review in this chat. Lead with the highest-risk findings. Cover correctness, regressions, missing tests, and unnecessary complexity. Cite file paths and line numbers. Skip praise and style nits unless they hide a defect. Do not edit the code; the findings file below is the only file you write.",
        "",
        reviewFindingsInstructions(
          "/repo/.context/reviews/2023-11-14T22-13-20-000Z-pr-42--codex.json",
        ),
      ].join("\n"),
      attachments: [
        { kind: "file", attachment: { ...uploadedFile, size: upload?.bytes.byteLength } },
      ],
      cwd: "/repo",
      provider: "codex",
      clientMessageId: "draft_review:initial-message",
      timestamp: 1_700_000_000_000,
      modeId: "plan",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      providerOptions: { fast_mode: true },
    });
    expect(useCreateFlowStore.getState().pendingByDraftId.draft_review?.attachments).toEqual([
      { ...uploadedFile, size: upload?.bytes.byteLength },
    ]);
  });

  it("opens a draft with the prompt and file when no provider is selected", async () => {
    const client = reviewClient();
    const started = await startReviewChat({
      client,
      serverId: "server-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      subject: { kind: "pull_request", pullRequest },
      preferences: {},
      draftId: "draft_review",
      now: 1_700_000_000_000,
    });

    expect(started).toEqual({
      draftId: "draft_review",
      submitted: false,
      target: { kind: "draft", draftId: "draft_review" },
    });
    const upload = client.uploads[0];
    expect(
      useDraftStore.getState().getDraftInput(
        buildDraftStoreKey({
          serverId: "server-1",
          agentId: "draft_review",
          draftId: "draft_review",
        }),
      ),
    ).toEqual({
      text: buildPullRequestReviewPrompt({
        fileName: "pr-42-review-context.md",
        findingsPath: reviewFindingsPath({
          cwd: "/repo",
          subject: { kind: "pull_request", pullRequest },
          startedAt: new Date(1_700_000_000_000),
        }),
        pullRequest,
      }),
      attachments: [
        {
          kind: "file",
          attachment: { ...uploadedFile, size: upload?.bytes.byteLength ?? 0 },
        },
      ],
    });
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual({});
  });

  it("starts a pull request review when the pull request targets another base", async () => {
    const client = reviewClient({
      diffError: "Base ref mismatch: stored refs/heads/main, requested release",
    });
    const started = await startReviewChat({
      client,
      serverId: "server-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      subject: { kind: "pull_request", pullRequest: { ...pullRequest, baseRef: "release" } },
      preferences: { provider: "codex" },
      draftId: "draft_review",
    });

    expect(started.submitted).toBe(true);
    const context = new TextDecoder().decode(client.uploads[0]?.bytes);
    expect(context).toContain(
      "The host could not load the changed files or the diff, because the workspace compares against a different base than release. Read them with `git diff release...feature/review`.",
    );
    expect(context).not.toContain("No changed files.");
  });

  it("does not upload a context file when the diff cannot be loaded", async () => {
    const client = reviewClient({ diffError: "diff failed" });
    await expect(
      startReviewChat({
        client,
        serverId: "server-1",
        workspaceId: "workspace-1",
        cwd: "/repo",
        subject: { kind: "pull_request", pullRequest },
        preferences: { provider: "codex" },
        draftId: "draft_review",
      }),
    ).rejects.toThrow("diff failed");
    expect(client.uploads).toEqual([]);
  });

  it("reviews the branch and working tree against the base when there is no pull request", async () => {
    const client = reviewClient();
    await startReviewChat({
      client,
      serverId: "server-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      subject: { kind: "local_changes", changes: { branch: "feature/review", baseRef: "main" } },
      preferences: { provider: "codex" },
      draftId: "draft_local",
      now: 1_700_000_000_000,
    });

    expect(client.diffRequests).toEqual([{ mode: "all", baseRef: "main" }]);
    const upload = client.uploads[0];
    expect(upload?.fileName).toBe("local-changes-review-context.md");
    expect(new TextDecoder().decode(upload?.bytes)).toContain("### src/app.ts");
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId.draft_local?.text).toBe(
      buildLocalChangesReviewPrompt({
        fileName: "local-changes-review-context.md",
        findingsPath: "/repo/.context/reviews/2023-11-14T22-13-20-000Z-local--codex.json",
        changes: { branch: "feature/review", baseRef: "main" },
      }),
    );
  });

  it("reviews only uncommitted changes when the workspace has no base branch", async () => {
    const client = reviewClient();
    await startReviewChat({
      client,
      serverId: "server-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      subject: { kind: "local_changes", changes: { branch: null, baseRef: null } },
      preferences: { provider: "codex" },
      draftId: "draft_local",
    });

    expect(client.diffRequests).toEqual([{ mode: "uncommitted" }]);
  });
});
