import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import {
  drainComposerAttachmentCommands,
  enqueueComposerAttachment,
  resetComposerAttachmentCommandQueue,
} from "./attachment-command-queue";

describe("composer attachment command queue", () => {
  beforeEach(() => {
    resetComposerAttachmentCommandQueue();
  });

  it("retains attachments by draft key until the targeted composer drains them", () => {
    const first = createWorkspaceFileAttachment({ path: "src/one.ts" });
    const second = createWorkspaceFileAttachment({ path: "src/two.ts" });

    enqueueComposerAttachment({ draftKey: "agent:host:one", attachment: first });
    enqueueComposerAttachment({ draftKey: "agent:host:two", attachment: second });

    expect(drainComposerAttachmentCommands("agent:host:one")).toEqual([
      { id: 1, attachment: first },
    ]);
    expect(drainComposerAttachmentCommands("agent:host:one")).toEqual([]);
    expect(drainComposerAttachmentCommands("agent:host:two")).toEqual([
      { id: 2, attachment: second },
    ]);
  });

  it("preserves attachment order while a composer is unmounted or hydrating", () => {
    const first = createWorkspaceFileAttachment({ path: "src/first.ts" });
    const second = createWorkspaceFileAttachment({ path: "src/second.ts" });

    enqueueComposerAttachment({ draftKey: "draft:host:draft-1", attachment: first });
    enqueueComposerAttachment({ draftKey: "draft:host:draft-1", attachment: second });

    expect(drainComposerAttachmentCommands("draft:host:draft-1")).toEqual([
      { id: 1, attachment: first },
      { id: 2, attachment: second },
    ]);
  });
});
