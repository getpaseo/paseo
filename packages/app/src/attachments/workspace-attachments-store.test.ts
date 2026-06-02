import { describe, expect, it } from "vitest";
import type { WorkspaceComposerAttachment } from "./types";
import {
  appendWorkspaceAttachment,
  buildWorkspaceAttachmentScopeKey,
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "./workspace-attachments-store";

function reviewAttachment(body: string): WorkspaceComposerAttachment {
  return {
    kind: "review",
    reviewDraftKey: `review:${body}`,
    commentCount: 1,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      comments: [
        {
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body,
          context: {
            hunkHeader: "@@ -40,1 +40,1 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
            ],
          },
        },
      ],
    },
  };
}

function contextAttachment(id: string): WorkspaceComposerAttachment {
  return {
    kind: "github.pull_request_comment",
    id,
    title: "Comment · octocat",
    text: "GitHub pull request comment\n\nLooks good.",
    url: `https://github.com/getpaseo/paseo/pull/42#${id}`,
  };
}

describe("workspace attachments store", () => {
  it("scopes workspace attachments by server and workspace before cwd fallback", () => {
    expect(
      buildWorkspaceAttachmentScopeKey({
        serverId: " local ",
        workspaceId: " workspace-1 ",
        cwd: "/repo",
      }),
    ).toBe("workspace-attachments:server=local:workspace=workspace-1");

    expect(
      buildWorkspaceAttachmentScopeKey({
        serverId: "local",
        workspaceId: null,
        cwd: "/repo/",
      }),
    ).toBe("workspace-attachments:server=local:cwd=%2Frepo");
  });

  it("publishes and clears attachments for a workspace scope", () => {
    resetWorkspaceAttachmentsStore();
    const scopeKey = buildWorkspaceAttachmentScopeKey({
      serverId: "local",
      workspaceId: "workspace-1",
      cwd: "/repo",
    });
    const attachment = reviewAttachment("Please simplify this.");

    useWorkspaceAttachmentsStore
      .getState()
      .setWorkspaceAttachments({ scopeKey, attachments: [attachment] });

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toEqual([
      attachment,
    ]);

    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey });

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toBeUndefined();
  });

  it("appends unique context attachments without dropping other workspace attachments", () => {
    const review = reviewAttachment("Please simplify this.");
    const context = contextAttachment("comment-1");

    expect(appendWorkspaceAttachment([review], context)).toEqual([review, context]);
  });

  it("dedupes repeated context attachments by provider, source, and id", () => {
    const original = contextAttachment("comment-1");
    const replacement = {
      ...contextAttachment("comment-1"),
      title: "Comment · octocat updated",
      text: "Updated text",
    };

    expect(appendWorkspaceAttachment([original], replacement)).toEqual([replacement]);
  });

  it("adds a workspace attachment against the current scope state", () => {
    resetWorkspaceAttachmentsStore();
    const scopeKey = buildWorkspaceAttachmentScopeKey({
      serverId: "local",
      workspaceId: "workspace-1",
      cwd: "/repo",
    });
    const review = reviewAttachment("Please simplify this.");
    const context = contextAttachment("comment-1");

    const addWorkspaceAttachment = useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment;
    useWorkspaceAttachmentsStore
      .getState()
      .setWorkspaceAttachments({ scopeKey, attachments: [review] });

    addWorkspaceAttachment({ scopeKey, attachment: context });

    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey]).toEqual([
      review,
      context,
    ]);
  });
});
