import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lastClaudeReply,
  lastCodexReply,
  readTranscriptLastReply,
} from "./transcript-last-reply.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("transcript last reply", () => {
  it("takes the last assistant text of a Claude transcript, skipping tool and thinking turns", () => {
    expect(
      lastClaudeReply([
        { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
        { type: "user", message: { content: [{ type: "text", text: "ok" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Soll ich mergen?" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } },
      ]),
    ).toBe("Soll ich mergen?");
  });

  it("prefers Codex's task_complete message and falls back to the assistant item", () => {
    expect(
      lastCodexReply([
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "older" }],
          },
        },
        {
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Fertig, bitte testen." },
        },
        { type: "event_msg", payload: { type: "token_count" } },
      ]),
    ).toBe("Fertig, bitte testen.");
    expect(
      lastCodexReply([
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "only item" }],
          },
        },
      ]),
    ).toBe("only item");
  });

  it("finds the transcript file of a Claude profile and a Codex profile by session id", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pandaos-transcripts-"));
    homes.push(home);
    await mkdir(path.join(home, ".claude", "projects", "-repo"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "projects", "-repo", "c1.jsonl"),
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude says" }] } })}\n`,
    );
    const day = path.join(home, ".codex-plus", "sessions", "2026", "09", "30");
    await mkdir(day, { recursive: true });
    const threadId = "01a0ee92-cc9f-7223-93b7-68947ec18d8e";
    await writeFile(
      path.join(day, `rollout-2026-09-30T10-00-00-${threadId}.jsonl`),
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "codex says" } })}\n`,
    );

    await expect(
      readTranscriptLastReply({ provider: "claude", sessionId: "c1" }, home),
    ).resolves.toBe("claude says");
    await expect(
      readTranscriptLastReply(
        { provider: "codex-plus", sessionId: threadId, metadata: { provider: "codex" } },
        home,
      ),
    ).resolves.toBe("codex says");
    await expect(
      readTranscriptLastReply({ provider: "opencode", sessionId: "x" }, home),
    ).resolves.toBeNull();
  });
});
