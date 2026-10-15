import { describe, expect, it } from "vitest";
import {
  listAntigravitySessions,
  readAntigravityTranscript,
  getAntigravitySessionTitle,
} from "./history.js";
import { mapHistoryToolDetail } from "./timeline.js";

describe("history utilities", () => {
  it("maps tool calls to appropriate ProviderToolCallDetail", () => {
    expect(mapHistoryToolDetail("run_command", { CommandLine: "ls -la" }, "output text")).toEqual({
      type: "shell",
      command: "ls -la",
      output: "output text",
    });

    expect(mapHistoryToolDetail("view_file", { AbsolutePath: "/foo/bar.txt" }, "content")).toEqual({
      type: "read",
      filePath: "/foo/bar.txt",
      content: "content",
    });

    expect(mapHistoryToolDetail("write_to_file", { TargetFile: "/foo/baz.ts" })).toEqual({
      type: "write",
      filePath: "/foo/baz.ts",
    });

    expect(mapHistoryToolDetail("replace_file_content", { TargetFile: "/foo/baz.ts" })).toEqual({
      type: "edit",
      filePath: "/foo/baz.ts",
    });

    expect(mapHistoryToolDetail("custom_unknown_tool", { foo: "bar" })).toEqual({
      type: "unknown",
      input: { foo: "bar" },
      output: null,
    });
  });

  it("handles non-existent conversation transcript gracefully", () => {
    const turns = readAntigravityTranscript("non-existent-conv-id-12345");
    expect(turns).toEqual([]);
  });

  it("handles non-existent conversation title gracefully", () => {
    const title = getAntigravitySessionTitle("non-existent-conv-id-12345");
    expect(title).toBeNull();
  });

  it("lists sessions without throwing", () => {
    const sessions = listAntigravitySessions({ limit: 5 });
    expect(Array.isArray(sessions)).toBe(true);
  });
});
