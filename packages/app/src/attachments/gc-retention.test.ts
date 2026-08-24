import { describe, expect, it } from "vitest";
import { collectRetainedAttachmentIds, retainAttachmentForGarbageCollection } from "./gc-retention";

describe("attachment garbage-collection retention", () => {
  it("keeps an attachment referenced until its final owner releases it", () => {
    const releaseFirst = retainAttachmentForGarbageCollection("preview-1");
    const releaseSecond = retainAttachmentForGarbageCollection("preview-1");

    expect(collectRetainedAttachmentIds()).toContain("preview-1");
    releaseFirst();
    expect(collectRetainedAttachmentIds()).toContain("preview-1");
    releaseSecond();
    expect(collectRetainedAttachmentIds()).not.toContain("preview-1");
  });
});
