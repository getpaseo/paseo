import { describe, expect, it } from "vitest";

import { mapOpencodeToolCall } from "./tool-call-mapper.js";

function expectMapped<T>(item: T | null): T {
  expect(item).toBeTruthy();
  if (!item) {
    throw new Error("Expected mapped tool call");
  }
  return item;
}

describe("opencode tool-call mapper", () => {
  it("labels execute calls with the Code Mode tool name", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-1",
        status: "running",
        input: {
          code: 'const r = await tools.hzmcp.memory__write_note({ project: "benjamin", title: "x" });\nreturn r;',
        },
        output: null,
      }),
    );

    expect(item.detail).toEqual({
      type: "plain_text",
      label: "hzmcp.memory__write_note",
      icon: "wrench",
      text: 'const r = await tools.hzmcp.memory__write_note({ project: "benjamin", title: "x" });\nreturn r;',
    });
  });

  it("labels execute calls with bracketed server accessors", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-2",
        status: "completed",
        input: { code: 'const tabs = await tools["charlotte"].charlotte_tabs({});' },
        output: "tab list",
      }),
    );

    expect(item.detail).toEqual({
      type: "plain_text",
      label: "charlotte.charlotte_tabs",
      icon: "wrench",
      text: 'const tabs = await tools["charlotte"].charlotte_tabs({});\n\ntab list',
    });
  });

  it("keeps unknown detail for execute calls without a recognizable tool chain", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-3",
        status: "completed",
        input: { code: "return 1 + 1;" },
        output: "2",
      }),
    );

    expect(item.detail?.type).toBe("unknown");
  });

  it("ignores tools mentioned in comments and keeps the executed call label", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-4",
        status: "running",
        input: {
          code: "// tools.old.lookup({})\n// use tools here\nawait tools.hzmcp.memory__write_note({});",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__write_note" });
  });

  it("ignores tools mentioned in string literals", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-5",
        status: "running",
        input: {
          code: 'const hint = "tools.fake.lookup({})";\nawait tools.hzmcp.memory__search_notes({});',
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("keeps template-literal interpolations as executed code", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-6",
        status: "running",
        input: {
          code: "const prefix = `result: ${tools.hzmcp.memory__search_notes({})}`;",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("keeps UTF-16 offsets when astral characters precede the call", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-8",
        status: "running",
        input: {
          code: 'const title = "📌 note";\nawait tools.hzmcp.memory__write_note({});',
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__write_note" });
  });

  it("ignores quotes inside regular-expression literals", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-9",
        status: "running",
        input: {
          code: "const re = /'/g;\nawait tools.hzmcp.memory__search_notes({});",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("treats division slashes as code, not regex literals", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-10",
        status: "running",
        input: {
          code: "const half = total / 2;\nawait tools.hzmcp.memory__search_notes({});",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("does not let masked strings change division-vs-regex detection", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-11",
        status: "running",
        input: {
          code: 'const half = "100" / 2;\nawait tools.hzmcp.memory__search_notes({ query: "/tmp" });',
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("does not join keywords across whitespace when detecting regexes", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-12",
        status: "running",
        input: {
          code: "async function check(s) { return await /'/.test(s); }\nawait tools.hzmcp.memory__search_notes({});",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("starts each template interpolation with fresh scanner state", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-13",
        status: "running",
        input: {
          code: "const s = `${1}${/'/.test(text)}`;\nawait tools.hzmcp.memory__search_notes({});",
        },
        output: null,
      }),
    );

    expect(item.detail).toMatchObject({ type: "plain_text", label: "hzmcp.memory__search_notes" });
  });

  it("keeps the executed code in the detail text alongside the output", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "execute",
        callId: "opencode-execute-7",
        status: "completed",
        input: { code: "await tools.hzmcp.memory__search_notes({ query: 'paseo' });" },
        output: "search results",
      }),
    );

    expect(item.detail).toMatchObject({
      type: "plain_text",
      label: "hzmcp.memory__search_notes",
      text: "await tools.hzmcp.memory__search_notes({ query: 'paseo' });\n\nsearch results",
    });
  });

  it("maps running shell calls", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "shell",
        callId: "opencode-call-1",
        status: "running",
        input: { command: "pwd", cwd: "/tmp/repo" },
        output: null,
      }),
    );

    expect(item.status).toBe("running");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-1");
    expect(item.detail?.type).toBe("shell");
    if (item.detail?.type === "shell") {
      expect(item.detail.command).toBe("pwd");
    }
  });

  it("maps running known tool variants with detail for early summaries", () => {
    const readItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-running-read",
        status: "running",
        input: { file_path: "README.md" },
        output: null,
      }),
    );
    expect(readItem.detail).toEqual({
      type: "read",
      filePath: "README.md",
    });

    const writeItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "write_file",
        callId: "opencode-running-write",
        status: "running",
        input: { file_path: "src/new.ts" },
        output: null,
      }),
    );
    expect(writeItem.detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
    });

    const editItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "apply_patch",
        callId: "opencode-running-edit",
        status: "running",
        input: { file_path: "src/index.ts" },
        output: null,
      }),
    );
    expect(editItem.detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
    });

    const searchItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "web_search",
        callId: "opencode-running-search",
        status: "running",
        input: { query: "opencode mapper" },
        output: null,
      }),
    );
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "opencode mapper",
      toolName: "web_search",
    });

    const globItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "glob",
        callId: "opencode-running-glob",
        status: "running",
        input: { pattern: "**/*.md" },
        output: null,
      }),
    );
    expect(globItem.detail).toEqual({
      type: "search",
      query: "**/*.md",
      toolName: "glob",
    });

    const grepItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "grep",
        callId: "opencode-running-grep",
        status: "running",
        input: { pattern: "sendCorrelatedSessionRequest" },
        output: null,
      }),
    );
    expect(grepItem.detail).toEqual({
      type: "search",
      query: "sendCorrelatedSessionRequest",
      toolName: "grep",
    });
  });

  it("maps completed read calls", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-call-2",
        status: "complete",
        input: { file_path: "README.md" },
        output: { content: "hello" },
      }),
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.callId).toBe("opencode-call-2");
    expect(item.detail?.type).toBe("read");
    if (item.detail?.type === "read") {
      expect(item.detail.filePath).toBe("README.md");
      expect(item.detail.content).toBe("hello");
    }
  });

  it("preserves read content from array/object output variants", () => {
    const arrayContent = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-read-array",
        status: "completed",
        input: { file_path: "README.md" },
        output: {
          content: [
            { type: "output_text", text: "alpha" },
            { type: "output_text", output: "beta" },
          ],
        },
      }),
    );

    expect(arrayContent.detail?.type).toBe("read");
    if (arrayContent.detail?.type === "read") {
      expect(arrayContent.detail.content).toBe("alpha\nbeta");
    }

    const objectContent = expectMapped(
      mapOpencodeToolCall({
        toolName: "read_file",
        callId: "opencode-read-object",
        status: "completed",
        input: { file_path: "README.md" },
        output: {
          data: {
            content: { type: "output_text", text: "gamma" },
          },
        },
      }),
    );

    expect(objectContent.detail?.type).toBe("read");
    if (objectContent.detail?.type === "read") {
      expect(objectContent.detail.content).toBe("gamma");
    }
  });

  it("unwraps OpenCode XML read output into file content", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "read",
        callId: "opencode-read-xml",
        status: "completed",
        input: { filePath: "/workspaces/paseo/docs/release.md" },
        output: [
          "<path>/workspaces/paseo/docs/release.md</path>",
          "<type>file</type>",
          "<content>",
          "1: # Release",
          "2:",
          "3: All workspaces share one version and release together.",
          "</content>",
        ].join("\n"),
      }),
    );

    expect(item.detail).toEqual({
      type: "read",
      filePath: "/workspaces/paseo/docs/release.md",
      content: [
        "1: # Release",
        "2:",
        "3: All workspaces share one version and release together.",
      ].join("\n"),
    });
  });

  it("maps failed calls with required error", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "shell",
        callId: "opencode-call-3",
        status: "error",
        input: { command: "false" },
        output: null,
        error: "command failed",
      }),
    );

    expect(item.status).toBe("failed");
    expect(item.error).toBe("command failed");
    expect(item.callId).toBe("opencode-call-3");
  });

  it("maps write/edit/search known variants into canonical detail", () => {
    const writeItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "write_file",
        callId: "opencode-write-1",
        status: "completed",
        input: { file_path: "src/new.ts", content: "const x = 1;" },
        output: null,
      }),
    );
    expect(writeItem.detail?.type).toBe("write");
    if (writeItem.detail?.type === "write") {
      expect(writeItem.detail.filePath).toBe("src/new.ts");
    }

    const editItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "apply_patch",
        callId: "opencode-edit-1",
        status: "completed",
        input: { file_path: "src/index.ts", diff: "@@\\n-old\\n+new\\n" },
        output: null,
      }),
    );
    expect(editItem.detail?.type).toBe("edit");
    if (editItem.detail?.type === "edit") {
      expect(editItem.detail.filePath).toBe("src/index.ts");
      expect(editItem.detail.unifiedDiff).toContain("@@");
    }

    const searchItem = expectMapped(
      mapOpencodeToolCall({
        toolName: "web_search",
        callId: "opencode-search-1",
        status: "completed",
        input: { query: "opencode mapper" },
        output: null,
      }),
    );
    expect(searchItem.detail).toEqual({
      type: "search",
      query: "opencode mapper",
      toolName: "web_search",
    });
  });

  it("maps completed write calls with OpenCode success text into canonical detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "write",
        callId: "opencode-write-success-text",
        status: "completed",
        input: {
          filePath: "/workspaces/paseo/worktrees/cold-ladybug/dummy.txt",
          content: "hello world\n",
        },
        output: "Wrote file successfully.",
      }),
    );

    expect(item.detail).toEqual({
      type: "write",
      filePath: "/workspaces/paseo/worktrees/cold-ladybug/dummy.txt",
      content: "hello world\n",
    });
  });

  it("maps completed edit calls with OpenCode camelCase input and success text", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "edit",
        callId: "opencode-edit-camel",
        status: "completed",
        input: {
          filePath: "/workspaces/paseo/packages/website/src/data/agent-pages.ts",
          oldString: 'metaTitle: "Agent page"',
          newString: 'metaTitle: "Updated agent page"',
        },
        output: "Edit applied successfully.",
      }),
    );

    expect(item.detail).toEqual({
      type: "edit",
      filePath: "/workspaces/paseo/packages/website/src/data/agent-pages.ts",
      oldString: 'metaTitle: "Agent page"',
      newString: 'metaTitle: "Updated agent page"',
    });
  });

  it("maps skill calls to plain text detail with the loaded skill name", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "skill",
        callId: "opencode-skill-1",
        status: "completed",
        input: { name: "diagnose" },
        output: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
      }),
    );

    expect(item.detail).toEqual({
      type: "plain_text",
      label: "diagnose",
      icon: "sparkles",
      text: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
    });
  });

  it("maps completed grep calls with string output into search detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "grep",
        callId: "opencode-grep-string-output-1",
        status: "completed",
        input: { pattern: "todowrite" },
        output: "Found 2 matches\nsrc/file.ts:\n  Line 1: todowrite",
      }),
    );

    expect(item.detail).toEqual({
      type: "search",
      query: "todowrite",
      toolName: "grep",
      content: "Found 2 matches\nsrc/file.ts:\n  Line 1: todowrite",
      numFiles: 0,
    });
  });

  it("maps apply_patch patchText payloads into edit detail", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Delete File: /tmp/repo/src/App.tsx",
      "*** End Patch",
    ].join("\n");

    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "apply_patch",
        callId: "opencode-apply-patch-text-1",
        status: "completed",
        input: { patchText },
        output: "Success. Updated the following files:\nD /tmp/repo/src/App.tsx",
      }),
    );

    expect(item.detail.type).toBe("edit");
    expect(item.detail).toEqual({
      type: "edit",
      filePath: "/tmp/repo/src/App.tsx",
      unifiedDiff: [
        "diff --git a//tmp/repo/src/App.tsx b//tmp/repo/src/App.tsx",
        "--- a//tmp/repo/src/App.tsx",
        "+++ /dev/null",
      ].join("\n"),
    });
  });

  it("maps OpenCode v2 patch payloads from GPT models into edit detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "patch",
        callId: "opencode-v2-patch-1",
        status: "completed",
        input: {
          patchText:
            "*** Begin Patch\n*** Update File: patch.txt\n@@\n-north south\n+NORTH south\n*** End Patch",
        },
        output: "Success. Updated the following files:\nM patch.txt",
      }),
    );

    expect(item.detail).toEqual({
      type: "edit",
      filePath: "patch.txt",
      unifiedDiff: [
        "diff --git a/patch.txt b/patch.txt",
        "--- a/patch.txt",
        "+++ b/patch.txt",
        "@@",
        "-north south",
        "+NORTH south",
      ].join("\n"),
    });
  });

  it("maps unknown tools to unknown detail with raw payloads", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "my_custom_tool",
        callId: "opencode-call-4",
        status: "completed",
        input: { foo: "bar" },
        output: { ok: true },
      }),
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toEqual({
      type: "unknown",
      input: { foo: "bar" },
      output: { ok: true },
    });
  });

  it("maps running task calls with subagent input to sub_agent detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "task",
        callId: "opencode-task-running",
        status: "running",
        input: {
          subagent_type: "explore",
          description: "Explore agent-tools codebase",
        },
        output: null,
      }),
    );

    expect(item.status).toBe("running");
    expect(item.error).toBeNull();
    expect(item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore agent-tools codebase",
      log: "",
      actions: [],
    });
  });

  it("maps completed task calls to sub_agent detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "task",
        callId: "opencode-task-completed",
        status: "completed",
        input: {
          subagent_type: "explore",
          description: "Explore agent-tools codebase",
        },
        output: { result: "Found the CLI entrypoint and provider registry." },
      }),
    );

    expect(item.status).toBe("completed");
    expect(item.error).toBeNull();
    expect(item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore agent-tools codebase",
      log: "",
      actions: [],
    });
  });

  it("extracts child session ids from current task metadata", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "task",
        callId: "opencode-task-completed-with-id",
        status: "completed",
        input: {
          subagent_type: "explore",
          description: "Explore current directory",
        },
        output: '<task id="ses_2268db431ffe299vL1bbot8R7Z">done</task>',
        metadata: { sessionId: "ses_2268db431ffe299vL1bbot8R7Z" },
      }),
    );

    expect(item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore current directory",
      childSessionId: "ses_2268db431ffe299vL1bbot8R7Z",
      log: "",
      actions: [],
    });
  });

  it("maps aborted task calls to sub_agent detail", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "task",
        callId: "opencode-task-aborted",
        status: "aborted",
        input: {
          subagent_type: "explore",
          description: "Explore agent-tools codebase",
        },
        output: null,
        error: "Tool execution aborted",
      }),
    );

    expect(item.status).toBe("failed");
    expect(item.error).toBe("Tool execution aborted");
    expect(item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore agent-tools codebase",
      log: "",
      actions: [],
    });
  });

  it("does not apply cross-provider speak normalization in opencode mapper", () => {
    const item = expectMapped(
      mapOpencodeToolCall({
        toolName: "paseo_voice.speak",
        callId: "opencode-call-voice-1",
        status: "completed",
        input: { text: "Voice response from OpenCode." },
        output: { ok: true },
      }),
    );

    expect(item.name).toBe("paseo_voice.speak");
    expect(item.detail).toEqual({
      type: "unknown",
      input: { text: "Voice response from OpenCode." },
      output: { ok: true },
    });
  });

  it("drops tool calls when callId is missing", () => {
    const item = mapOpencodeToolCall({
      toolName: "read_file",
      callId: null,
      status: "completed",
      input: { file_path: "README.md" },
      output: { content: "hello" },
    });

    expect(item).toBeNull();
  });
});
