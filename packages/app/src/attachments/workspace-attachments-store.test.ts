import { describe, expect, it } from "vitest";
import type { WorkspaceComposerAttachment } from "./types";
import {
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
});
