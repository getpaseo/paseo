import { describe, expect, it } from "vitest";
import {
  buildDiffRangeChatReference,
  buildFileChatReference,
  buildHunkChatReference,
  buildHunkLineChatReference,
} from "./chat-reference-token";

describe("buildFileChatReference", () => {
  it("returns the file path unchanged", () => {
    expect(buildFileChatReference("src/example.ts")).toBe("src/example.ts");
  });
});

describe("buildHunkChatReference", () => {
  it("formats a single-line hunk as path:line", () => {
    expect(
      buildHunkChatReference({
        path: "src/example.ts",
        hunk: {
          oldStart: 12,
          oldCount: 1,
          newStart: 12,
          newCount: 1,
          lines: [],
        },
      }),
    ).toBe("src/example.ts:12");
  });

  it("formats a multi-line hunk as path:start-end", () => {
    expect(
      buildHunkChatReference({
        path: "src/example.ts",
        hunk: {
          oldStart: 12,
          oldCount: 4,
          newStart: 12,
          newCount: 7,
          lines: [],
        },
      }),
    ).toBe("src/example.ts:12-18");
  });

  it("uses the new-side range for add-only hunks", () => {
    expect(
      buildHunkChatReference({
        path: "src/example.ts",
        hunk: {
          oldStart: 0,
          oldCount: 0,
          newStart: 42,
          newCount: 3,
          lines: [],
        },
      }),
    ).toBe("src/example.ts:42-44");
  });

  it("falls back to the old-side range for delete-only hunks", () => {
    expect(
      buildHunkChatReference({
        path: "src/example.ts",
        hunk: {
          oldStart: 18,
          oldCount: 2,
          newStart: 18,
          newCount: 0,
          lines: [],
        },
      }),
    ).toBe("src/example.ts:18-19");
  });
});

describe("buildDiffRangeChatReference", () => {
  it("prefers the new-side range when it exists", () => {
    expect(
      buildDiffRangeChatReference({
        path: "src/example.ts",
        oldStart: 83,
        oldCount: 2,
        newStart: 102,
        newCount: 1,
      }),
    ).toBe("src/example.ts:102");
  });
});

describe("buildHunkLineChatReference", () => {
  it("uses the local add/remove block instead of the whole hunk", () => {
    const hunk = {
      oldStart: 67,
      oldCount: 39,
      newStart: 70,
      newCount: 36,
      lines: [
        { type: "header" as const, content: "@@ -67,39 +70,36 @@" },
        { type: "context" as const, content: "unchanged" },
        { type: "remove" as const, content: "old one" },
        { type: "remove" as const, content: "old two" },
        { type: "add" as const, content: "new one" },
        { type: "context" as const, content: "after" },
      ],
    };

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 2,
      }),
    ).toBe("src/example.ts:71");

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 3,
      }),
    ).toBe("src/example.ts:71");
  });

  it("uses the hovered context line for context rows", () => {
    const hunk = {
      oldStart: 10,
      oldCount: 2,
      newStart: 10,
      newCount: 2,
      lines: [
        { type: "header" as const, content: "@@ -10,2 +10,2 @@" },
        { type: "context" as const, content: "same line" },
      ],
    };

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 1,
      }),
    ).toBe("src/example.ts:10");
  });

  it("uses surrounding new-side context for delete-only blocks", () => {
    const hunk = {
      oldStart: 237,
      oldCount: 8,
      newStart: 239,
      newCount: 2,
      lines: [
        { type: "header" as const, content: "@@ -237,8 +239,2 @@" },
        { type: "context" as const, content: "before" },
        { type: "remove" as const, content: "deleted one" },
        { type: "remove" as const, content: "deleted two" },
        { type: "remove" as const, content: "deleted three" },
        { type: "remove" as const, content: "deleted four" },
        { type: "remove" as const, content: "deleted five" },
        { type: "remove" as const, content: "deleted six" },
        { type: "context" as const, content: "after" },
      ],
    };

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 2,
      }),
    ).toBe("src/example.ts:239-240");

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 7,
      }),
    ).toBe("src/example.ts:239-240");
  });

  it("falls back to the deleted old-side range when no surrounding new context exists", () => {
    const hunk = {
      oldStart: 18,
      oldCount: 2,
      newStart: 18,
      newCount: 0,
      lines: [
        { type: "header" as const, content: "@@ -18,2 +18,0 @@" },
        { type: "remove" as const, content: "deleted one" },
        { type: "remove" as const, content: "deleted two" },
      ],
    };

    expect(
      buildHunkLineChatReference({
        path: "src/example.ts",
        hunk,
        lineIndex: 1,
      }),
    ).toBe("src/example.ts:18-19");
  });
});
