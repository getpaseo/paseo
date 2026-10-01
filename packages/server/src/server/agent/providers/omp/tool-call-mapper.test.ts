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

  test("uses current OMP task arguments and wait results for readable rows", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          name: "Docs",
          agent: "explore",
          task: "Read src/a.ts",
          solutionSpace: "Report findings",
        }),
        null,
      ),
    ).toMatchObject({ type: "sub_agent", subAgentType: "Docs", description: "Read src/a.ts" });
    expect(
      mapOmpToolDetail(
        parseToolArgs("wait", {}),
        parseToolResult({ content: [{ type: "text", text: "Waiting for Docs to finish" }] }),
      ),
    ).toMatchObject({ type: "plain_text", label: "Waiting for Docs to finish" });
  });

  test("names a task from OMP's tasks array while it runs and after it completes", () => {
    const call = parseToolArgs("task", {
      context: "Read a scratch file",
      tasks: [{ name: "ReadNotes", task: "Read src/notes.ts and report its content" }],
      i: "Delegating the read",
    });
    expect(mapOmpToolDetail(call, null)).toMatchObject({
      type: "sub_agent",
      subAgentType: "ReadNotes",
      description: "Delegating the read",
    });
    expect(
      mapOmpToolDetail(
        call,
        parseToolResult({ content: [{ type: "text", text: "Spawned agent `ReadNotes`" }] }),
      ),
    ).toMatchObject({ type: "sub_agent", subAgentType: "ReadNotes" });
  });

  test("uses the first task instruction when OMP omits its short intent", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          tasks: [
            {
              name: "WaitThenRead",
              task: "# Target src/notes.ts in the scratch repository.\n# Change\nRun bash sleep 8.",
            },
          ],
        }),
        null,
      ),
    ).toMatchObject({
      type: "sub_agent",
      subAgentType: "WaitThenRead",
      description: "src/notes.ts in the scratch repository.",
    });
  });

  test("skips a standalone target heading in a running task", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          tasks: [
            {
              name: "SlowRead",
              task: "# Target\nsrc/notes.ts in the scratch repository.\n# Change\nRead the file.",
            },
          ],
        }),
        null,
      ),
    ).toMatchObject({ description: "src/notes.ts in the scratch repository." });
  });

  test("names a structured subagent yield by its action", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("yield", { data: { content: "done" } }),
        parseToolResult({ content: [{ type: "text", text: "Result submitted." }] }),
      ),
    ).toEqual({
      type: "plain_text",
      label: "Submitted subagent result",
      text: "Result submitted.",
    });
  });

  test("connects a steered background bash call with its wait result", () => {
    const command = "sleep 2; echo finished";
    expect(
      mapOmpToolDetail(
        parseToolArgs("bash", { command }),
        parseToolResult({
          content: [
            {
              type: "text",
              text: "Backgrounded early to handle an incoming message; the command keeps running.\nJob: bg_1",
            },
          ],
        }),
      ),
    ).toMatchObject({ type: "shell", command });
    const resultText =
      "## Completed (1)\n\n### bg_1 [bash] — completed\nLabel: sleep 2; echo finished\nDelivery: not auto-delivered; recovered by this snapshot.\n```\nfinished\n```";
    expect(
      mapOmpToolDetail(
        parseToolArgs("wait", {}),
        parseToolResult({
          content: [{ type: "text", text: resultText }],
          details: {
            op: "wait",
            jobs: [
              {
                id: "bg_1",
                type: "bash",
                status: "completed",
                label: command,
                resultText: "finished",
              },
            ],
          },
        }),
      ),
    ).toEqual({ type: "plain_text", label: `bash completed: ${command}`, text: "finished" });
  });

  test("maps web search and URL reads to search and fetch", () => {
    expect(mapOmpToolDetail(parseToolArgs("web_search", { query: "Paseo" }), null)).toMatchObject({
      type: "search",
      query: "Paseo",
      toolName: "web_search",
    });
    expect(
      mapOmpToolDetail(parseToolArgs("read", { path: "https://example.com/" }), null),
    ).toMatchObject({ type: "fetch", url: "https://example.com/" });
  });

  test("names virtual device calls from their path on failure and while running", () => {
    expect(mapOmpToolDetail(parseToolArgs("read", { path: "xd://ast_grep" }), null)).toMatchObject({
      type: "plain_text",
      label: "ast_grep",
    });
    expect(
      mapOmpToolDetail(parseToolArgs("write", { path: "xd://lsp", content: "{}" }), null),
    ).toMatchObject({ type: "plain_text", label: "lsp" });
  });

  test("renders executed OMP device tools with readable action and output", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("write", { path: "xd://github", content: '{"op":"status"}' }),
        parseToolResult({
          content: [{ type: "text", text: "Working tree clean" }],
          details: {
            xdev: { tool: "github", mode: "execute", args: { op: "status" }, inner: {} },
          },
        }),
      ),
    ).toEqual({ type: "plain_text", label: "status", text: "Working tree clean" });
  });

  test("shows the first question in an ask row", () => {
    expect(
      mapOmpToolDetail(parseToolArgs("ask", { questions: [{ question: "Which file?" }] }), null),
    ).toMatchObject({ type: "plain_text", label: "Which file?" });
  });

  test("shows the question and selected answers after ask completes", () => {
    const detail = mapOmpToolDetail(
      parseToolArgs("ask", { questions: [{ question: "Which colors?" }] }),
      parseToolResult({
        content: [{ type: "text", text: "User selected: Red, Blue" }],
        details: { question: "Which colors?", selectedOptions: ["Red", "Blue"] },
      }),
    );
    expect(detail).toEqual({
      type: "plain_text",
      label: "Which colors?",
      text: "Which colors?\nRed, Blue",
    });
  });

  test("shows meaningful labels for OMP's remaining built-in tools", () => {
    expect(mapOmpToolDetail(parseToolArgs("glob", { pattern: "src/**/*.ts" }), null)).toMatchObject(
      { type: "search", query: "src/**/*.ts", toolName: "glob" },
    );
    expect(
      mapOmpToolDetail(parseToolArgs("ast_grep", { pattern: "console.log($X)" }), null),
    ).toMatchObject({ type: "search", query: "console.log($X)" });
    expect(
      mapOmpToolDetail(parseToolArgs("checkpoint", { goal: "Inspect parser" }), null),
    ).toMatchObject({ type: "plain_text", label: "Inspect parser" });
    expect(
      mapOmpToolDetail(parseToolArgs("manage_skill", { action: "create", name: "demo" }), null),
    ).toMatchObject({ type: "plain_text", label: "create demo" });
    expect(
      mapOmpToolDetail(parseToolArgs("think", { thoughts: "Check the next step" }), null),
    ).toEqual({
      type: "plain_text",
      label: "Thinking",
      text: "Check the next step",
    });
  });

  test("uses OMP ast_grep pat as the search query", () => {
    expect(
      mapOmpToolDetail(parseToolArgs("ast_grep", { pat: "console.log($A)" }), null),
    ).toMatchObject({
      type: "search",
      query: "console.log($A)",
    });
  });
});
