import { describe, expect, it } from "vitest";
import { describeDetail, describeRequest, describeToolCall, lastToolCall } from "./detail-text";
import type { PermissionRequest, TimelineItem } from "./types";

describe("describeDetail", () => {
  it("names the file for file tools and shows the path", () => {
    expect(
      describeDetail("Write", { type: "write", filePath: "/tmp/demo/a.txt" } as never),
    ).toEqual({
      headline: "Write a.txt",
      preview: "/tmp/demo/a.txt",
    });
  });

  it("shows the command for shell and the first line only", () => {
    expect(describeDetail("Bash", { type: "shell", command: "npm test\n# more" } as never)).toEqual(
      {
        headline: "Bash",
        preview: "npm test",
      },
    );
  });

  it("falls back to well-known input keys when there is no detail", () => {
    expect(describeDetail("Read", undefined, { file_path: "/src/index.ts" })).toEqual({
      headline: "Read index.ts",
      preview: "/src/index.ts",
    });
    expect(describeDetail("Grep", undefined, { pattern: "TODO" })).toEqual({
      headline: "Grep",
      preview: "TODO",
    });
    expect(describeDetail("Mystery", undefined, {})).toEqual({
      headline: "Mystery",
      preview: null,
    });
  });
});

describe("describeRequest", () => {
  it("prefers the request's own title and description", () => {
    const request = {
      id: "p",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run tests",
      description: "Runs the unit suite",
      detail: { type: "shell", command: "npm test" },
    } as unknown as PermissionRequest;
    expect(describeRequest(request)).toEqual({
      headline: "Run tests",
      preview: "Runs the unit suite",
    });
  });
});

describe("tool call text", () => {
  const items = [
    { type: "assistant_message", text: "hi" },
    {
      type: "tool_call",
      callId: "1",
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "ls" },
    },
    {
      type: "tool_call",
      callId: "2",
      name: "Edit",
      status: "running",
      error: null,
      detail: { type: "edit", filePath: "/a/b.ts" },
    },
  ] as unknown as TimelineItem[];

  it("finds the last tool call and describes it", () => {
    const item = lastToolCall(items);
    expect(item?.callId).toBe("2");
    expect(describeToolCall(item!)).toBe("Edit b.ts: /a/b.ts");
    expect(lastToolCall([])).toBeNull();
  });
});
