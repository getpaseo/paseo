import { beforeEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { mergePendingPrompt, usePendingPromptStore } from "./pending-prompt-store";

function image(id: string): { kind: "image"; metadata: AttachmentMetadata } {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: `/tmp/${id}.png`,
      createdAt: 0,
    },
  };
}

describe("pending prompt store", () => {
  beforeEach(() => {
    usePendingPromptStore.setState({ byDraftKey: {} });
  });

  it("hands a staged prompt to the first taker only", () => {
    const store = usePendingPromptStore.getState();
    store.stage({ draftKey: "new-workspace", prompt: { text: "fix the tests", attachments: [] } });

    expect(store.take("new-workspace")).toEqual({ text: "fix the tests", attachments: [] });
    expect(store.take("new-workspace")).toBeNull();
    expect(store.take("agent:host:agent-1")).toBeNull();
  });

  it("merges prompts staged for the same draft before anyone takes them", () => {
    const store = usePendingPromptStore.getState();
    store.stage({ draftKey: "k", prompt: { text: "first", attachments: [image("a")] } });
    store.stage({ draftKey: "k", prompt: { text: "second", attachments: [image("b")] } });

    expect(store.take("k")).toEqual({
      text: "first\n\nsecond",
      attachments: [image("a"), image("b")],
    });
  });
});

describe("mergePendingPrompt", () => {
  it("appends after the existing draft text with a blank line between", () => {
    expect(
      mergePendingPrompt(
        { text: "draft so far  \n", attachments: [] },
        { text: "  https://example.com/issue/1 ", attachments: [] },
      ),
    ).toEqual({ text: "draft so far\n\nhttps://example.com/issue/1", attachments: [] });
  });

  it("keeps the existing text untouched when the pending prompt is only attachments", () => {
    expect(
      mergePendingPrompt(
        { text: "keep me\n", attachments: [] },
        { text: "   ", attachments: [image("shot")] },
      ),
    ).toEqual({ text: "keep me\n", attachments: [image("shot")] });
  });

  it("uses the pending text alone when the draft is empty", () => {
    expect(
      mergePendingPrompt({ text: "   ", attachments: [] }, { text: "hello", attachments: [] }),
    ).toEqual({ text: "hello", attachments: [] });
  });
});
