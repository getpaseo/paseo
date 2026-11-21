import { describe, expect, test } from "vitest";

import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  splitPiToolResultImages,
} from "./tool-call-mapper.js";

describe("Pi tool call mapper", () => {
  test("maps bash args and result to shell detail", () => {
    const toolCall = parseToolArgs("bash", { command: "echo hello" });
    const result = parseToolResult({ output: "hello\n", exitCode: 0 });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "shell",
      command: "echo hello",
      output: "hello\n",
      exitCode: 0,
    });
  });

  test("maps legacy edit args to edit detail with diff", () => {
    const toolCall = parseToolArgs("edit", {
      path: "app.ts",
      old_string: "before",
      new_string: "after",
    });
    const result = parseToolResult({ details: { diff: "-before\n+after" } });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "edit",
      filePath: "app.ts",
      oldString: "before",
      newString: "after",
      unifiedDiff: "-before\n+after",
    });
  });

  test("preserves ordinary writes as write details", () => {
    const toolCall = parseToolArgs("write", {
      path: "notes.txt",
      content: "unchanged\n",
    });

    expect(mapToolDetail(toolCall, parseToolResult({ text: "Wrote notes.txt" }))).toEqual({
      type: "write",
      filePath: "notes.txt",
      content: "unchanged\n",
    });
  });

  test("preserves unknown tool input and parsed output", () => {
    const toolCall = parseToolArgs("custom_tool", { value: 42 });
    const result = parseToolResult({ text: "custom result" });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { value: 42 },
      output: { text: "custom result" },
    });
  });
});

describe("splitPiToolResultImages", () => {
  test("extracts image blocks and replaces them with [image] placeholders", () => {
    const parsed = parseToolResult({
      content: [
        { type: "text", text: "shot taken" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    const { images, result } = splitPiToolResultImages(parsed);

    expect(images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
    expect(result).toEqual({
      content: [
        { type: "text", text: "shot taken" },
        { type: "text", text: "[image]" },
      ],
    });
  });

  test("replaces image-only results with a non-empty placeholder", () => {
    const parsed = parseToolResult({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
    });
    const { images, result } = splitPiToolResultImages(parsed);

    expect(images).toHaveLength(1);
    expect(extractTextFromToolResult(result)).toBe("[image]");
  });

  test("passes through string results and results without images", () => {
    expect(splitPiToolResultImages("plain output")).toEqual({
      images: [],
      result: "plain output",
    });
    const textOnly = parseToolResult({ content: [{ type: "text", text: "no images" }] });
    expect(splitPiToolResultImages(textOnly)).toEqual({ images: [], result: textOnly });
    expect(splitPiToolResultImages(null)).toEqual({ images: [], result: null });
  });

  test("keeps other fields on the result object", () => {
    const parsed = parseToolResult({
      exitCode: 0,
      content: [{ type: "image", data: "aGVsbG8=" }],
    });
    const { result } = splitPiToolResultImages(parsed);
    expect(result).toMatchObject({ exitCode: 0 });
  });
});

test("tool-result images remove nested structured image data while preserving metadata", () => {
  const data = Buffer.from("nested screenshot bytes").toString("base64");
  const result = parseToolResult({
    content: [{ type: "image", data, mimeType: "image/png" }],
    structuredContent: {
      content: [{ type: "image", data, mimeType: "image/png", width: 64 }],
      captureId: "capture-1",
      read: { type: "image", data, mimeType: "image/png", note: "Read image file" },
      extra: { data: "keep ordinary data" },
    },
  });
  const split = splitPiToolResultImages(result);
  const detail = mapToolDetail(parseToolArgs("screenshot", {}), split.result);
  expect(JSON.stringify(detail)).not.toContain(data);
  expect(split.images).toEqual([{ data, mimeType: "image/png" }]);
  expect(split.result).toMatchObject({
    structuredContent: {
      content: [{ type: "image", data: "[image]", mimeType: "image/png", width: 64 }],
      captureId: "capture-1",
      read: { type: "image", data: "[image]", mimeType: "image/png", note: "Read image file" },
      extra: { data: "keep ordinary data" },
    },
  });
});
