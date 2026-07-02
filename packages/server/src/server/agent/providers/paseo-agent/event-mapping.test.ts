import { describe, expect, it } from "vitest";

import {
  convertPromptInput,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
} from "./event-mapping.js";

describe("parseToolArgs", () => {
  it("classifies known built-in tools", () => {
    expect(parseToolArgs("bash", { command: "ls" }).kind).toBe("bash");
    expect(parseToolArgs("read", { path: "/tmp/a" }).kind).toBe("read");
    expect(parseToolArgs("grep", { pattern: "foo" }).kind).toBe("grep");
  });

  it("falls back to unknown for unrecognized tools or bad args", () => {
    expect(parseToolArgs("mcp__paseo__do", { anything: 1 }).kind).toBe("unknown");
    expect(parseToolArgs("bash", { notACommand: true }).kind).toBe("unknown");
  });

  it("accepts legacy edit args (old_string/new_string)", () => {
    const call = parseToolArgs("edit", {
      path: "/tmp/a",
      old_string: "x",
      new_string: "y",
    });
    expect(call.kind).toBe("edit");
    if (call.kind === "edit") {
      expect(call.args.edits[0]).toEqual({ oldText: "x", newText: "y" });
    }
  });
});

describe("mapToolDetail", () => {
  it("maps a bash call with exit code and output", () => {
    const call = parseToolArgs("bash", { command: "echo hi" });
    const detail = mapToolDetail(call, parseToolResult({ output: "hi", exitCode: 0 }));
    expect(detail).toMatchObject({ type: "shell", command: "echo hi", output: "hi", exitCode: 0 });
  });

  it("maps an edit call to a diff detail", () => {
    const call = parseToolArgs("edit", {
      path: "/tmp/a",
      edits: [{ oldText: "a", newText: "b" }],
    });
    const detail = mapToolDetail(call, parseToolResult({ details: { diff: "--- diff ---" } }));
    expect(detail).toMatchObject({
      type: "edit",
      filePath: "/tmp/a",
      oldString: "a",
      newString: "b",
      unifiedDiff: "--- diff ---",
    });
  });

  it("maps unknown tools to a passthrough detail", () => {
    const call = parseToolArgs("mystery", { foo: 1 });
    const detail = mapToolDetail(call, parseToolResult("done"));
    expect(detail.type).toBe("unknown");
  });
});

describe("convertPromptInput", () => {
  it("passes a plain string through", () => {
    expect(convertPromptInput("hello")).toEqual({ text: "hello" });
  });

  it("joins text blocks and collects images", () => {
    const payload = convertPromptInput([
      { type: "text", text: "one" },
      { type: "image", data: "base64", mimeType: "image/png" },
      { type: "text", text: "two" },
    ]);
    expect(payload.text).toBe("one\n\ntwo");
    expect(payload.images).toEqual([{ type: "image", data: "base64", mimeType: "image/png" }]);
  });
});
