import { beforeEach, describe, expect, it } from "vitest";
import {
  appendComposerInsertion,
  drainComposerInsertions,
  enqueueComposerInsertion,
  resetComposerInsertionQueue,
} from "./insertion-queue";

describe("composer insertion text", () => {
  it("appends quoted file text without changing the existing draft", () => {
    expect(
      appendComposerInsertion({
        currentText: "Keep this draft exactly",
        insertionText: '"src/components/chat.tsx"',
      }),
    ).toBe('Keep this draft exactly\n"src/components/chat.tsx"');
  });

  it("uses existing trailing whitespace as the separator", () => {
    expect(
      appendComposerInsertion({
        currentText: "Keep this draft exactly  ",
        insertionText: '"src/components/chat.tsx"',
      }),
    ).toBe('Keep this draft exactly  "src/components/chat.tsx"');
  });

  it("does not prefix an empty draft", () => {
    expect(
      appendComposerInsertion({
        currentText: "",
        insertionText: '"src/components/chat.tsx"',
      }),
    ).toBe('"src/components/chat.tsx"');
  });
});

describe("composer insertion queue", () => {
  beforeEach(() => {
    resetComposerInsertionQueue();
  });

  it("retains commands by draft store key until that composer drains them", () => {
    enqueueComposerInsertion({ draftKey: "agent:host:one", text: '"one.ts"' });
    enqueueComposerInsertion({ draftKey: "agent:host:two", text: '"two.ts"' });

    expect(drainComposerInsertions("agent:host:one")).toEqual([{ id: 1, text: '"one.ts"' }]);
    expect(drainComposerInsertions("agent:host:one")).toEqual([]);
    expect(drainComposerInsertions("agent:host:two")).toEqual([{ id: 2, text: '"two.ts"' }]);
  });

  it("preserves insertion order while a composer is unmounted or hydrating", () => {
    enqueueComposerInsertion({ draftKey: "draft:host:draft-1", text: '"first.ts"' });
    enqueueComposerInsertion({ draftKey: "draft:host:draft-1", text: '"second.ts"' });

    expect(drainComposerInsertions("draft:host:draft-1")).toEqual([
      { id: 1, text: '"first.ts"' },
      { id: 2, text: '"second.ts"' },
    ]);
  });
});
