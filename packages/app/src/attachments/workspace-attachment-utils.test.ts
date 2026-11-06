import { describe, expect, it } from "vitest";
import type { ComposerAttachment, PullRequestContextAttachment } from "./types";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
  workspaceAttachmentToSubmitAttachment,
} from "./workspace-attachment-utils";

function contextAttachment(
  overrides: Partial<PullRequestContextAttachment> = {},
): PullRequestContextAttachment {
  return {
    kind: "github.pull_request_comment",
    id: "comment-1",
    title: "Comment · octocat",
    subtitle: "Fix flaky build",
    text: "GitHub pull request comment\n\nLooks good.",
    url: "https://github.com/getpaseo/paseo/pull/42#issuecomment-1",
    ...overrides,
  };
}

describe("workspace attachment utilities", () => {
  it("submits chat history with its source host and agent", () => {
    const source = { serverId: "original-host", agentId: "original-agent", title: "Original" };
    expect(
      workspaceAttachmentToSubmitAttachment({
        kind: "chat_history",
        id: "history-draft",
        attachment: {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          text: "Earlier context",
          chatHistoryEntries: [{ id: "history-0", role: "user", text: "Earlier context" }],
        },
        source,
      }),
    ).toEqual({
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      text: "Earlier context",
      chatHistoryEntries: [{ id: "history-0", role: "user", text: "Earlier context" }],
      chatHistorySource: source,
    });
  });

  it("treats pull request context as a workspace attachment", () => {
    expect(isWorkspaceAttachment(contextAttachment())).toBe(true);
  });

  it("strips context attachments from user draft attachments", () => {
    const normalAttachment: ComposerAttachment = {
      kind: "github_issue",
      item: {
        kind: "issue",
        number: 12,
        title: "Bug",
        url: "https://github.com/getpaseo/paseo/issues/12",
        state: "open",
        body: "Bug report",
        labels: [],
        baseRefName: null,
        headRefName: null,
      },
    };

    expect(userAttachmentsOnly([normalAttachment, contextAttachment()])).toEqual([
      normalAttachment,
    ]);
  });

  it("serializes context attachments as protocol text attachments", () => {
    expect(workspaceAttachmentToSubmitAttachment(contextAttachment())).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "Comment · octocat",
      text: "GitHub pull request comment\n\nLooks good.",
    });
  });
});
