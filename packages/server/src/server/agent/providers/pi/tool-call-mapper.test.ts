import { describe, expect, test } from "vitest";

import { mapToolDetail, parseToolArgs, parseToolResult } from "./tool-call-mapper.js";

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

  test("extracts object result text blocks for grep, find, and ls search details", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: "src/alpha.ts:12:needle" },
        { type: "text", text: "src/beta.ts:5:needle" },
      ],
    });

    expect(mapToolDetail(parseToolArgs("grep", { pattern: "needle" }), result)).toEqual({
      type: "search",
      query: "needle",
      toolName: "grep",
      content: "src/alpha.ts:12:needle\nsrc/beta.ts:5:needle",
    });
    expect(
      mapToolDetail(parseToolArgs("find", { pattern: "needle", path: "src", limit: 5 }), result),
    ).toEqual({
      type: "search",
      query: "needle",
      toolName: "search",
      content: "src/alpha.ts:12:needle\nsrc/beta.ts:5:needle",
    });
    expect(mapToolDetail(parseToolArgs("ls", { path: "src" }), result)).toEqual({
      type: "search",
      query: "src",
      content: "src/alpha.ts:12:needle\nsrc/beta.ts:5:needle",
    });
  });

  test("preserves raw string results as grep search content", () => {
    expect(
      mapToolDetail(
        parseToolArgs("grep", { pattern: "needle" }),
        parseToolResult("src/alpha.ts:12:needle"),
      ),
    ).toEqual({
      type: "search",
      query: "needle",
      toolName: "grep",
      content: "src/alpha.ts:12:needle",
    });
  });
});
