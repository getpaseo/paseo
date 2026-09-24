import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAgentHistoryContentCache,
  conversationTextFromClaudeJsonl,
  conversationTextFromCursorBlobs,
  conversationTextFromGrokJsonl,
  conversationTextFromOpenCodeParts,
  loadAgentHistoryContent,
  type HistoryContentRoots,
} from "./agent-history-content.js";

afterEach(() => {
  clearAgentHistoryContentCache();
});

describe("conversation text extractors", () => {
  it("keeps grok user and assistant text and skips reasoning", () => {
    const raw = [
      JSON.stringify({ type: "reasoning", summary: "hidden chain" }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Where is the obsidian kanban note?" }],
      }),
      JSON.stringify({
        type: "assistant",
        content: [{ type: "text", text: "It is in the vault under plugins." }],
      }),
    ].join("\n");
    const text = conversationTextFromGrokJsonl(raw);
    expect(text).toContain("obsidian kanban");
    expect(text).toContain("vault under plugins");
    expect(text).not.toContain("hidden chain");
  });

  it("reads claude user and assistant message content", () => {
    const raw = [
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "file the google export" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Filed under tank photos." },
      }),
    ].join("\n");
    const text = conversationTextFromClaudeJsonl(raw);
    expect(text).toContain("file the google export");
    expect(text).toContain("Filed under tank photos");
    expect(text).not.toContain("enqueue");
  });

  it("reads cursor user and assistant json blobs and skips system prompts", () => {
    const blobs = [
      Buffer.from(JSON.stringify({ role: "system", content: "You are an agent." })),
      Buffer.from(JSON.stringify({ role: "user", content: "SuperGrok usage versus Cursor" })),
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Cursor bills separately." }],
        }),
      ),
      Buffer.from([0x0a, 0x8b, 0x01]),
    ];
    const text = conversationTextFromCursorBlobs(blobs);
    expect(text).toContain("SuperGrok usage versus Cursor");
    expect(text).toContain("Cursor bills separately");
    expect(text).not.toContain("You are an agent");
  });

  it("reads opencode text parts", () => {
    const text = conversationTextFromOpenCodeParts([
      JSON.stringify({ type: "text", text: "Alert summary for the airflow job" }),
      JSON.stringify({ type: "tool", text: "ignored tool wrapper" }),
    ]);
    expect(text).toContain("airflow job");
    expect(text).not.toContain("ignored tool wrapper");
  });
});

describe("loadAgentHistoryContent", () => {
  it("loads a grok session by id from the sessions directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-"));
    const roots = await rootsUnder(root);
    const sessionId = "01a0-grok-session";
    const sessionDir = path.join(roots.grokSessionsDir, "%2Fwork%2Frepo", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: "unique grok phrase xylophone" })}\n`,
    );

    const text = await loadAgentHistoryContent(
      { provider: "grok", persistence: { sessionId } },
      roots,
    );
    expect(text).toContain("unique grok phrase xylophone");
  });

  it("loads a claude jsonl by session id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-"));
    const roots = await rootsUnder(root);
    const sessionId = "claude-session-1";
    const projectDir = path.join(roots.claudeProjectsDir, "-work-repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: { content: "unique claude phrase zither" },
      })}\n`,
    );

    const text = await loadAgentHistoryContent(
      { provider: "claude", persistence: { sessionId } },
      roots,
    );
    expect(text).toContain("unique claude phrase zither");
  });

  it("loads cursor and opencode stores", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-"));
    const roots = await rootsUnder(root);
    const cursorId = "cursor-session-1";
    const cursorDir = path.join(roots.cursorSessionsDir, cursorId);
    await mkdir(cursorDir, { recursive: true });
    const cursorDb = new DatabaseSync(path.join(cursorDir, "store.db"));
    cursorDb.exec("CREATE TABLE blobs (id TEXT, data BLOB)");
    cursorDb
      .prepare("INSERT INTO blobs (id, data) VALUES (?, ?)")
      .run(
        "1",
        Buffer.from(JSON.stringify({ role: "user", content: "unique cursor phrase harp" })),
      );
    cursorDb.close();

    const opencodeDb = new DatabaseSync(roots.opencodeDbPath);
    opencodeDb.exec(
      "CREATE TABLE part (id TEXT, session_id TEXT, data TEXT); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)",
    );
    opencodeDb
      .prepare("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)")
      .run("p1", "ses_open", JSON.stringify({ type: "text", text: "unique opencode phrase lute" }));
    opencodeDb.close();

    const cursorText = await loadAgentHistoryContent(
      { provider: "cursor", persistence: { sessionId: cursorId } },
      roots,
    );
    const opencodeText = await loadAgentHistoryContent(
      { provider: "opencode", persistence: { sessionId: "ses_open" } },
      roots,
    );
    expect(cursorText).toContain("unique cursor phrase harp");
    expect(opencodeText).toContain("unique opencode phrase lute");
  });

  it("rejects a session id that tries to leave the store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-"));
    const roots = await rootsUnder(root);
    const text = await loadAgentHistoryContent(
      { provider: "grok", persistence: { sessionId: "../secrets" } },
      roots,
    );
    expect(text).toBe("");
  });
});

async function rootsUnder(root: string): Promise<HistoryContentRoots> {
  const roots: HistoryContentRoots = {
    grokSessionsDir: path.join(root, "grok"),
    claudeProjectsDir: path.join(root, "claude"),
    cursorSessionsDir: path.join(root, "cursor"),
    opencodeDbPath: path.join(root, "opencode.db"),
  };
  await mkdir(roots.grokSessionsDir, { recursive: true });
  await mkdir(roots.claudeProjectsDir, { recursive: true });
  await mkdir(roots.cursorSessionsDir, { recursive: true });
  return roots;
}
