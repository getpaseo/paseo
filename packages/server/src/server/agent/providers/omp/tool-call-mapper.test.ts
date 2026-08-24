import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

describe("OMP tool call mapper", () => {
  test("maps OMP bash, read, hashline edit, and write calls", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("bash", { command: "echo hi" }),
        parseToolResult({
          content: [{ type: "text", text: "hi\n\n\nWall time: 0.02 seconds" }],
        }),
      ),
    ).toEqual({
      type: "shell",
      command: "echo hi",
      output: "hi\n\n\nWall time: 0.02 seconds",
      exitCode: null,
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("read", { path: "fixture.txt" }),
        parseToolResult({
          content: [{ type: "text", text: "[fixture.txt#0063]\n1:alpha\n2:beta\n3:" }],
          details: { displayContent: { text: "alpha\nbeta\n" } },
        }),
      ),
    ).toEqual({
      type: "read",
      filePath: "fixture.txt",
      content: "alpha\nbeta\n",
      offset: undefined,
      limit: undefined,
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("edit", {
          input: "*** Begin Patch\n[fixture.txt#0063]\nSWAP 2.=2:\n+gamma\n*** End Patch\n",
        }),
        parseToolResult({
          content: [],
          details: {
            path: "fixture.txt",
            oldText: "alpha\nbeta\n",
            newText: "alpha\ngamma\n",
            diff: " 1|alpha\n-2|beta\n+2|gamma",
          },
        }),
      ),
    ).toEqual({
      type: "edit",
      filePath: "fixture.txt",
      oldString: "alpha\nbeta\n",
      newString: "alpha\ngamma\n",
      unifiedDiff: " 1|alpha\n-2|beta\n+2|gamma",
    });
    expect(
      mapOmpToolDetail(
        parseToolArgs("write", { path: "created.txt", content: "hello write" }),
        null,
      ),
    ).toEqual({
      type: "write",
      filePath: "created.txt",
      content: "hello write",
    });
  });

  test("maps task to sub-agent detail and suppresses todo raw cards", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        null,
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      log: "",
    });
    expect(mapOmpToolDetail(parseToolArgs("todo", { op: "view" }), null)).toBeNull();
  });

  test("uses task result text and transcript path as the best static replay detail", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        parseToolResult({
          content: [
            {
              type: "text",
              text: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
            },
          ],
        }),
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      childSessionId: "/tmp/omp-task-static/Explore.jsonl",
      log: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
    });
  });

  test("falls back to shared unknown detail for unmapped tools", () => {
    expect(mapOmpToolDetail(parseToolArgs("lsp", { op: "hover" }), null)).toEqual({
      type: "unknown",
      input: { op: "hover" },
      output: null,
    });
  });
});
