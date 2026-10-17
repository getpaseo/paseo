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
  emptyHistoryConversation,
  loadAgentHistoryContent,
  type HistoryContentRoots,
} from "./agent-history-content.js";

afterEach(() => {
  clearAgentHistoryContentCache();
});

describe("conversation text extractors", () => {
  it("keeps grok user and assistant text and puts summary text in thinking", () => {
    const raw = [
      JSON.stringify({ type: "reasoning", summary: "hidden chain" }),
      JSON.stringify({
        type: "reasoning",
        encrypted_content: "secret xylophone blob",
        summary: [{ type: "summary_text", text: "pondering the kanban board" }],
      }),
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
    expect(text.user).toContain("obsidian kanban");
    expect(text.reply).toContain("vault under plugins");
    expect(text.thinking).toContain("pondering the kanban board");
    expect(text.thinking).not.toContain("hidden chain");
    expect(JSON.stringify(text)).not.toContain("secret xylophone blob");
    expect(JSON.stringify(text)).not.toContain("hidden chain");
  });

  it("reads a grok user_query and ignores injected wrappers", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        content: [
          {
            type: "text",
            text: "<user_info>kanban lives in the info block</user_info><rules>kanban lives in the rules</rules><user_query>Where is the obsidian note?</user_query>",
          },
        ],
      }),
      JSON.stringify({
        type: "user",
        content: "<system-reminder>kanban inside the reminder</system-reminder>",
      }),
      JSON.stringify({
        type: "user",
        content: "<user_info>xylophone in info</user_info><rules>xylophone in rules</rules>",
      }),
    ].join("\n");
    const text = conversationTextFromGrokJsonl(raw);
    expect(text.user).toContain("obsidian note");
    expect(text.user).not.toContain("kanban");
    expect(text.user).not.toContain("xylophone");
    expect(JSON.stringify(text)).not.toContain("xylophone");
  });

  it("keeps a grok reply out of an earlier tool result", () => {
    const raw = [
      JSON.stringify({
        type: "tool_result",
        content: "The authorization dump from the tool ran first.",
      }),
      JSON.stringify({
        type: "assistant",
        content: "The reply mentions authorization at the end.",
        tool_calls: [{ id: "call-1", name: "bash", arguments: '{"cmd":"authorization dump"}' }],
      }),
      JSON.stringify({
        type: "backend_tool_call",
        kind: { tool_type: "web_search", action: { query: "backend authorization query" } },
      }),
    ].join("\n");
    const text = conversationTextFromGrokJsonl(raw);
    expect(text.reply).toContain("reply mentions authorization");
    expect(text.reply).not.toContain("dump from the tool");
    expect(text.tool).toContain("authorization dump from the tool");
    expect(text.tool).toContain("backend authorization query");
    expect(text.tool).not.toContain("call-1");
  });

  it("reads claude user and assistant message content", () => {
    const raw = [
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", content: "tool output xylophone" },
            { type: "text", text: "file the google export" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden claude thought", signature: "encrypted-thought" },
            { type: "text", text: "Filed under tank photos." },
            { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls photos" } },
          ],
        },
      }),
    ].join("\n");
    const text = conversationTextFromClaudeJsonl(raw);
    expect(text.user).toContain("file the google export");
    expect(text.user).not.toContain("xylophone");
    expect(text.reply).toContain("Filed under tank photos");
    expect(text.thinking).toContain("hidden claude thought");
    expect(text.thinking).not.toContain("encrypted-thought");
    expect(text.tool).toContain("tool output xylophone");
    expect(text.tool).toContain("ls photos");
    expect(JSON.stringify(text)).not.toContain("enqueue");
  });

  it("reads cursor user and assistant json blobs and skips system prompts", () => {
    const blobs = [
      Buffer.from(JSON.stringify({ role: "system", content: "You are an agent." })),
      Buffer.from(JSON.stringify({ role: "user", content: "SuperGrok usage versus Cursor" })),
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "reasoning", text: "cursor thought", signature: "encrypted-cursor-thought" },
            { type: "text", text: "Cursor bills separately." },
            {
              type: "tool-call",
              toolCallId: "tc_1",
              toolName: "grep",
              args: { pattern: "secret-tool-pattern" },
            },
          ],
        }),
      ),
      Buffer.from(
        JSON.stringify({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc_1",
              toolName: "grep",
              result: "tool result blob",
            },
          ],
        }),
      ),
      Buffer.from([0x0a, 0x8b, 0x01]),
    ];
    const text = conversationTextFromCursorBlobs(blobs);
    expect(text.user).toContain("SuperGrok usage versus Cursor");
    expect(text.reply).toContain("Cursor bills separately");
    expect(text.thinking).toContain("cursor thought");
    expect(text.thinking).not.toContain("encrypted-cursor-thought");
    expect(text.tool).toContain("secret-tool-pattern");
    expect(text.tool).toContain("tool result blob");
    expect(JSON.stringify(text)).not.toContain("You are an agent");
  });

  it("reads opencode text parts and keeps tool text in the tool band", () => {
    const text = conversationTextFromOpenCodeParts([
      {
        data: JSON.stringify({ type: "text", text: "Alert summary for the airflow job" }),
        role: "user",
      },
      JSON.stringify({ type: "tool", text: "ignored tool wrapper" }),
    ]);
    expect(text.user).toContain("airflow job");
    expect(text.reply).not.toContain("ignored tool wrapper");
    expect(text.tool).toContain("ignored tool wrapper");
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
    expect(text.user).toContain("unique grok phrase xylophone");
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
    expect(text.reply).toContain("unique claude phrase zither");
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
    expect(cursorText.user).toContain("unique cursor phrase harp");
    expect(opencodeText.reply).toContain("unique opencode phrase lute");
  });

  it("rejects a session id that tries to leave the store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-history-"));
    const roots = await rootsUnder(root);
    const text = await loadAgentHistoryContent(
      { provider: "grok", persistence: { sessionId: "../secrets" } },
      roots,
    );
    expect(text).toEqual(emptyHistoryConversation());
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
