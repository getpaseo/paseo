import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  appendWorkspaceFileAttachment,
  createWorkspaceFileAttachment,
  getWorkspaceFileAttachmentKey,
  getWorkspaceFileAttachmentSubtitle,
  workspaceFileAttachmentToAgentAttachment,
} from "./workspace-file";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";

describe("workspace file attachments", () => {
  it("models whole files and line ranges as distinct selections", () => {
    const wholeFile = createWorkspaceFileAttachment({ path: "src/app.ts" });
    const lineRange = createWorkspaceFileAttachment({
      path: "src/app.ts",
      selection: { kind: "line_range", startLine: 12, endLine: 24 },
    });

    expect(wholeFile).toEqual({
      kind: "workspace_file",
      path: "src/app.ts",
      selection: { kind: "whole_file" },
    });
    expect(getWorkspaceFileAttachmentKey(wholeFile)).not.toBe(
      getWorkspaceFileAttachmentKey(lineRange),
    );
    expect(getWorkspaceFileAttachmentSubtitle(wholeFile)).toBe("src/app.ts");
    expect(getWorkspaceFileAttachmentSubtitle(lineRange)).toBe("src/app.ts · 12-24");
  });

  it("deduplicates only identical paths and selections", () => {
    const image = {
      kind: "image" as const,
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb" as const,
        storageKey: "image-1",
        createdAt: 1,
      },
    };
    const wholeFile = createWorkspaceFileAttachment({ path: "src/app.ts" });
    const range = createWorkspaceFileAttachment({
      path: "src/app.ts",
      selection: { kind: "line_range", startLine: 1, endLine: 5 },
    });
    const current: UserComposerAttachment[] = [image, wholeFile];

    expect(appendWorkspaceFileAttachment(current, wholeFile)).toBe(current);
    expect(appendWorkspaceFileAttachment(current, range)).toEqual([image, wholeFile, range]);
  });

  it("submits a path reference without uploading or inserting prompt text", () => {
    const attachment = createWorkspaceFileAttachment({
      path: "src/app.ts",
      selection: { kind: "line_range", startLine: 12, endLine: 24 },
    });

    expect(workspaceFileAttachmentToAgentAttachment(attachment)).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "app.ts",
      text: "Workspace file: src/app.ts\nLines: 12-24",
    });
    expect(splitComposerAttachmentsForSubmit([attachment])).toEqual({
      images: [],
      attachments: [workspaceFileAttachmentToAgentAttachment(attachment)],
    });
  });
});
