import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { ClaudeQueryFactory } from "./query.js";

const sessionId = "original-claude-session";
const prefix = [
  { type: "user", uuid: "first", parentUuid: null, message: { content: "First prompt" } },
  { type: "assistant", uuid: "answer", parentUuid: "first", message: { content: "First answer" } },
];
const prompt = {
  type: "user",
  uuid: "retry",
  parentUuid: "answer",
  message: { content: "Second prompt" },
};

describe("Claude conversation rewind anchors", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "paseo-rewind-"));
    const configDir = path.join(root, "provider-home");
    const dir = claudeProjectDirSync(root, { configDir });
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${sessionId}.jsonl`);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function open(entries: readonly object[], queryFactory?: ClaudeQueryFactory) {
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => process.execPath,
      queryFactory,
    });
    return client.resumeSession({ provider: "claude", sessionId }, { cwd: root });
  }

  test.each(["revertConversation", "revertBoth"] as const)(
    "%s rejects an empty prefix before touching files or starting a query",
    async (method) => {
      const launch = vi.fn<ClaudeQueryFactory>(() => {
        throw new Error("First-message rewind must not start Claude");
      });
      const session = await open(prefix, launch);
      try {
        const before = readFileSync(file, "utf8");
        await expect(session[method]!({ messageId: "first" })).rejects.toThrow(
          /before the first message.*new session/i,
        );
        expect(session.id).toBe(sessionId);
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(launch).not.toHaveBeenCalled();
        expect(readdirSync(path.dirname(file))).toEqual([`${sessionId}.jsonl`]);
      } finally {
        await session.close();
      }
    },
  );

  test("keeps a turn's actual last entry even if it was a tool result, not an assistant reply", async () => {
    const toolResult = {
      type: "user",
      uuid: "tool-result",
      parentUuid: "answer",
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: "tool output" }] },
    };
    const sidechain = {
      type: "assistant",
      isSidechain: true,
      uuid: "subagent",
      parentUuid: "answer",
      message: { content: "Subagent output" },
    };
    const launch = vi.fn<ClaudeQueryFactory>(() => {
      throw new Error("Stop before starting the provider");
    });
    const session = await open(
      [...prefix, toolResult, sidechain, { ...prompt, parentUuid: "tool-result" }],
      launch,
    );
    try {
      await session.revertConversation!({ messageId: "retry" });
      expect(await session.canStopRuntime?.()).toBe(false);
      await collectSessionTurnEvents(session, "replacement");
      expect(launch.mock.calls[0]?.[0].options).toMatchObject({
        resume: sessionId,
        resumeSessionAt: "tool-result",
        resumeDropsTurn: "retry",
      });
    } finally {
      await session.close();
    }
  });

  test("keeps a valid anchor when the discarded turn had no assistant reply", async () => {
    const session = await open([...prefix, prompt]);
    try {
      await session.revertConversation!({ messageId: "retry" });
      const events = await Array.fromAsync(session.streamHistory());
      expect(events.filter((e) => e.type === "timeline").map((e) => e.item.type)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(session.id).toBe(sessionId);
    } finally {
      await session.close();
    }
  });

  test("does not discard another prompt appended after selecting a multi-turn rewind", async () => {
    const later = {
      ...prompt,
      uuid: "third",
      parentUuid: "retry",
      message: { content: "Third prompt" },
    };
    const entries = [...prefix, prompt, later];
    const launch = vi.fn<ClaudeQueryFactory>(() => {
      throw new Error("A stale rewind must not start the provider");
    });
    const session = await open(entries, launch);
    try {
      await session.revertConversation!({ messageId: "retry" });
      const external = {
        ...prompt,
        uuid: "external",
        parentUuid: "third",
        message: { content: "External prompt" },
      };
      writeFileSync(file, [...entries, external].map((e) => JSON.stringify(e)).join("\n") + "\n");
      const result = await collectSessionTurnEvents(session, "replacement");
      expect(result).toContainEqual(
        expect.objectContaining({ type: "turn_failed", code: "rewind_rejected" }),
      );
      expect(launch).not.toHaveBeenCalled();
      const full = await Array.fromAsync(session.streamHistory());
      expect(full).toContainEqual(
        expect.objectContaining({
          item: expect.objectContaining({ type: "user_message", messageId: "external" }),
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("uses the queued command's parent when rewinding a mid-turn steer", async () => {
    const steer = {
      type: "attachment",
      uuid: "queued",
      parentUuid: "answer",
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        source_uuid: "steer",
        prompt: "wait",
      },
    };
    const launch = vi.fn<ClaudeQueryFactory>(() => {
      throw new Error("Stop before starting the provider");
    });
    const session = await open([...prefix, steer], launch);
    try {
      await session.revertConversation!({ messageId: "steer" });
      await collectSessionTurnEvents(session, "replacement");
      const options = launch.mock.calls[0]?.[0].options;
      expect(options).toMatchObject({ resume: sessionId, resumeSessionAt: "answer" });
      expect(options?.resumeDropsTurn).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
