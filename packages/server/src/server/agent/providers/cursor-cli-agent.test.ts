import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { CursorCliAgentClient, CursorCliAgentSession } from "./cursor-cli-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.restoreAllMocks();
});

describe("CursorCliAgentClient", () => {
  test("exposes cursor provider id and capabilities", () => {
    const client = new CursorCliAgentClient({ logger: createTestLogger() });
    expect(client.provider).toBe("cursor");
    expect(client.capabilities.supportsStreaming).toBe(true);
    expect(client.capabilities.supportsSessionPersistence).toBe(true);
  });

  test("streamHistory replays transcript history from .cursor/projects", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cursor-home-"));
    process.env.HOME = home;

    const cwd = "/Users/test/workspace/paseo";
    const sessionId = "cursor-session-1";
    const transcriptDir = path.join(
      home,
      ".cursor",
      "projects",
      "Users-test-workspace-paseo",
      "agent-transcripts",
      sessionId,
    );
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_query>\nhello cursor\n</user_query>" }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "first reply" },
              { type: "tool_use", name: "Shell", input: { command: "pwd" } },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "second reply" }] },
        }),
      ].join("\n"),
      "utf8",
    );

    const session = new CursorCliAgentSession(
      { provider: "cursor", cwd },
      {
        logger: createTestLogger(),
        resumeChatId: sessionId,
      },
    );

    const events = [];
    for await (const event of session.streamHistory()) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "cursor",
        item: { type: "user_message", text: "hello cursor" },
      },
      {
        type: "timeline",
        provider: "cursor",
        item: { type: "assistant_message", text: "first reply" },
      },
      {
        type: "timeline",
        provider: "cursor",
        item: { type: "assistant_message", text: "second reply" },
      },
    ]);

    const replayedAgain = [];
    for await (const event of session.streamHistory()) {
      replayedAgain.push(event);
    }
    expect(replayedAgain).toEqual([]);
  });
});
