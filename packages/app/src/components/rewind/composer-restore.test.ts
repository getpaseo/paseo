import { describe, expect, test } from "vitest";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import type { UploadedFileAttachment } from "@getpaseo/protocol/messages";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { restoreComposerAttachmentsIfEmpty, restoreComposerTextIfEmpty } from "./composer-restore";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";

describe("restoreComposerTextIfEmpty", () => {
  test("restores the rewound message when the composer is empty", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "",
        rewoundText: "message before rewind",
      }),
    ).toBe("message before rewind");
  });

  test("preserves an existing composer draft", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "keep this draft",
        rewoundText: "message before rewind",
      }),
    ).toBe("keep this draft");
  });
});

describe("shouldRestoreComposerForRewindMode", () => {
  test("restores only conversation-mutating rewind modes", () => {
    expect(shouldRestoreComposerForRewindMode("conversation")).toBe(true);
    expect(shouldRestoreComposerForRewindMode("files")).toBe(false);
    expect(shouldRestoreComposerForRewindMode("both")).toBe(true);
  });
});

const image: AttachmentMetadata = {
  id: "image-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "image-1",
  fileName: "screenshot.png",
  createdAt: 1,
};
const file: UploadedFileAttachment = {
  type: "uploaded_file",
  id: "file-1",
  fileName: "notes.txt",
  mimeType: "text/plain",
  size: 5,
  path: "/uploads/notes.txt",
};

describe("restoreComposerAttachmentsIfEmpty", () => {
  test("restores images and uploaded files ready for resubmission", () => {
    const restored = restoreComposerAttachmentsIfEmpty({
      currentAttachments: [],
      rewoundMessage: { text: "Review these", images: [image], attachments: [file] },
    });
    expect(restored).toEqual([
      { kind: "image", metadata: image },
      { kind: "file", attachment: file },
    ]);
    expect(splitComposerAttachmentsForSubmit(restored)).toEqual({
      images: [image],
      attachments: [file],
    });
  });

  test("preserves attachments added to an existing draft", () => {
    const draft: UserComposerAttachment[] = [{ kind: "file", attachment: file }];
    expect(
      restoreComposerAttachmentsIfEmpty({
        currentAttachments: draft,
        rewoundMessage: { text: "", images: [image] },
      }),
    ).toBe(draft);
  });

  test("restores an image-only message", () => {
    expect(
      restoreComposerAttachmentsIfEmpty({
        currentAttachments: [],
        rewoundMessage: { text: "", images: [image] },
      }),
    ).toEqual([{ kind: "image", metadata: image }]);
  });

  test("keeps text-only messages free of attachments", () => {
    expect(
      restoreComposerAttachmentsIfEmpty({
        currentAttachments: [],
        rewoundMessage: { text: "hello" },
      }),
    ).toEqual([]);
  });
});
