import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readClaudeCompactedContext } from "./agent.js";

function transcript(entries: unknown[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claude-compacted-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The shape Claude Code 2.1 writes: kept messages before the boundary, the summary after it.
const SUMMARY_TEXT = [
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
  "",
  "<tools-used-before-summary>Bash, Edit, Read</tools-used-before-summary>",
  "Summary:",
  "The user wants the code word PLOVER kept.",
  "",
  "If you need specific details from before compaction (like exact code snippets), read the full transcript at: C:\\Users\\me\\.claude\\projects\\x\\session.jsonl",
  "Continue the conversation from where it left off without asking the user any further questions.",
].join("\n");

test("reads the newest compaction without lines that only make sense inside Claude Code", async () => {
  const { path, cleanup } = transcript([
    { type: "user", uuid: "u1", message: { role: "user", content: "Old prompt" } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running it." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "r1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "all tests passed" }],
      },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "b1",
      compactMetadata: { trigger: "auto", preservedMessages: { uuids: ["a1", "r1"] } },
    },
    { type: "attachment", uuid: "x1" },
    {
      type: "user",
      uuid: "s1",
      isCompactSummary: true,
      message: { role: "user", content: SUMMARY_TEXT },
    },
    { type: "user", uuid: "u2", message: { role: "user", content: "After the compaction" } },
  ]);
  try {
    const text = await readClaudeCompactedContext(path);
    expect(text).toContain("The user wants the code word PLOVER kept.");
    expect(text).not.toContain("tools-used-before-summary");
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("Continue the conversation from where it left off");
    // The kept messages follow word for word, without Claude Code's tool name.
    expect(text).toContain('{"role":"assistant","text":"Running it."}');
    expect(text).toContain('{"tool_input":{"command":"npm test"}}');
    expect(text).toContain('{"tool_result":"all tests passed"}');
    expect(text).not.toContain("Bash");
    expect(text).not.toContain("Old prompt");
    expect(text).not.toContain("After the compaction");
  } finally {
    cleanup();
  }
});

test("a transcript without a compaction gives no summary", async () => {
  const { path, cleanup } = transcript([
    { type: "user", uuid: "u1", message: { role: "user", content: "Only prompt" } },
  ]);
  try {
    expect(await readClaudeCompactedContext(path)).toBeNull();
  } finally {
    cleanup();
  }
});
