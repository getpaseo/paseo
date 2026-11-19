import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient, extractUserMessageText } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { withClaudeReplayHistory } from "./transcript-history.js";

describe("Claude rewind history", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paseo-rewind-history-"));
    file = path.join(claudeProjectDirSync(dir, { configDir: dir }), "session.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  function write(entries: object[]) {
    return writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  }
  function read(throughUuid?: string) {
    return withClaudeReplayHistory(
      file,
      async (history) => Array.fromAsync(history.parentEntries),
      throughUuid,
    );
  }

  test("previews the selected prefix without changing subsequent reads of the transcript", async () => {
    const entries = [
      { type: "user", uuid: "prompt", parentUuid: null },
      { type: "assistant", uuid: "call", parentUuid: "prompt" },
      {
        type: "user",
        uuid: "result",
        parentUuid: "call",
        message: { content: [{ type: "tool_result", tool_use_id: "tool" }] },
      },
      {
        type: "attachment",
        uuid: "steer",
        parentUuid: "result",
        attachment: { type: "queued_command", source_uuid: "steered-prompt" },
      },
      { type: "assistant", uuid: "reply", parentUuid: "steer" },
      { type: "user", uuid: "amend", parentUuid: "reply" },
    ];
    await write(entries);
    expect(await read("result")).toEqual(entries.slice(0, 3));
    expect(await read("steer")).toEqual(entries.slice(0, 4));
    await expect(read("missing")).rejects.toThrow(/missing/);
    expect(await read()).toEqual(entries);
  });

  test("a replacement prompt cold-loads only the current branch and cannot rewind to a discarded UUID", async () => {
    const entries = [
      { type: "user", uuid: "u1", parentUuid: null },
      { type: "assistant", uuid: "a1", parentUuid: "u1" },
      { type: "attachment", uuid: "end-turn", parentUuid: "a1" },
      { type: "user", uuid: "old-u2", parentUuid: "end-turn" },
      { type: "assistant", uuid: "old-a2", parentUuid: "old-u2" },
      { type: "last-prompt" },
      { type: "user", uuid: "new-u2", parentUuid: "end-turn" },
      { type: "assistant", uuid: "new-a2", parentUuid: "new-u2" },
    ];
    await write(entries);
    expect(await read()).toEqual([...entries.slice(0, 3), ...entries.slice(6)]);
    expect(await read("new-u2")).toEqual([...entries.slice(0, 3), entries[6]]);
    await expect(read("old-a2")).rejects.toThrow(/old-a2/);
  });

  test("keeps pre-compaction history, parallel tool results and legacy rows", async () => {
    const entries = [
      { type: "user", message: { content: "legacy" } },
      { type: "assistant", uuid: "tools" },
      ...["one", "two"].map((uuid) => ({
        type: "user",
        uuid,
        parentUuid: "tools",
        message: { content: [{ type: "tool_result", tool_use_id: uuid }] },
      })),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "two",
      },
      { type: "user", uuid: "summary", isCompactSummary: true, parentUuid: "boundary" },
      { type: "user", uuid: "continue", parentUuid: "summary" },
      { type: "content-replacement", uuid: "metadata" },
    ];
    await write(entries);
    expect(await read()).toEqual(entries);
    await expect(read("metadata")).rejects.toThrow(/metadata/);
    expect(
      await withClaudeReplayHistory(file, async (history) => history.headUuid, "summary"),
    ).toBe("continue");
  });

  test("does not restore child agents or workflows declared only in a discarded turn", async () => {
    const root = path.join(path.dirname(file), "session");
    const children = path.join(root, "subagents");
    const workflows = path.join(root, "workflows");
    await mkdir(children, { recursive: true });
    await mkdir(workflows);
    await writeFile(
      path.join(children, "agent-child.meta.json"),
      JSON.stringify({ toolUseId: "task" }),
    );
    await writeFile(
      path.join(children, "agent-child.jsonl"),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "child",
        message: { content: "old child reply" },
      }),
    );
    await writeFile(
      path.join(workflows, "run.json"),
      JSON.stringify({ runId: "wf_old", status: "completed" }),
    );
    const original = [
      { type: "user", uuid: "keep", message: { content: "keep" } },
      { type: "assistant", uuid: "kept-reply", parentUuid: "keep", message: { content: "kept" } },
      { type: "user", uuid: "old", parentUuid: "kept-reply", message: { content: "discard" } },
      {
        type: "assistant",
        uuid: "tools",
        parentUuid: "old",
        message: {
          content: [
            { type: "tool_use", name: "Task", id: "task", input: { description: "child" } },
            { type: "tool_use", name: "Workflow", id: "workflow", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "results",
        parentUuid: "tools",
        message: {
          content: [{ type: "tool_result", tool_use_id: "workflow", content: "Run ID: wf_old" }],
        },
      },
    ];
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: dir } },
      resolveVersion: async () => "2.1.325",
    });
    async function declared() {
      const session = await client.resumeSession(
        { provider: "claude", sessionId: "session" },
        { cwd: dir },
      );
      try {
        const stream = await Array.fromAsync(session.streamHistory());
        return new Set(
          stream.flatMap((event) => (event.type === "provider_subagent" ? [event.event.id] : [])),
        );
      } finally {
        await session.close();
      }
    }
    await write(original);
    expect(await declared()).toEqual(new Set(["task", "workflow"]));
    await write([
      ...original,
      {
        type: "user",
        uuid: "replace",
        parentUuid: "kept-reply",
        message: { content: "replacement" },
      },
    ]);
    expect(await declared()).toEqual(new Set());
  });
});

describe("extractUserMessageText", () => {
  test("returns trimmed string content", () => {
    expect(extractUserMessageText("  Hello world  ")).toBe("Hello world");
  });

  test("combines multiple text blocks", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];

    expect(extractUserMessageText(content)).toBe("First line\n\nSecond line");
  });

  test("returns Claude slash command prompts without transcript tags", () => {
    const content =
      "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>";

    expect(extractUserMessageText(content)).toBe("/diagnose recently the PR data does not update");
  });

  test("returns the Claude slash command prompt when no args were recorded", () => {
    const content =
      "<command-message>caveman:caveman</command-message>\n<command-name>/caveman:caveman</command-name>";

    expect(extractUserMessageText(content)).toBe("/caveman:caveman");
  });

  test("returns null when no textual content is present", () => {
    const content = [
      { type: "image", source: "foo.png" },
      { type: "file", path: "bar.txt" },
    ];

    expect(extractUserMessageText(content)).toBeNull();
  });
});
