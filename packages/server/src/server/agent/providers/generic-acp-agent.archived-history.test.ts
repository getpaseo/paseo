import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient archived history", () => {
  test("replays an archived session whose working directory was removed", async () => {
    await withFakeACPAgent(async ({ command, removedCwd, loadRequestsPath }) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });

      const session = await client.resumeSession(
        { provider: "acp", sessionId: "archived-session", metadata: { cwd: removedCwd } },
        undefined,
        undefined,
        { purpose: "history" },
      );
      try {
        expect(await collectTimelineText(session.streamHistory())).toEqual([
          "user_message:What is in the README?",
          "assistant_message:It describes the project.",
        ]);
        const loadRequests = JSON.parse(await readFile(loadRequestsPath, "utf8"));
        expect(loadRequests).toEqual([{ sessionId: "archived-session", cwd: removedCwd }]);
      } finally {
        await session.close();
      }
    });
  });

  test("still requires the working directory to resume a session that will run", async () => {
    await withFakeACPAgent(async ({ command, removedCwd }) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });

      await expect(
        client.resumeSession(
          { provider: "acp", sessionId: "archived-session", metadata: { cwd: removedCwd } },
          undefined,
          undefined,
          { purpose: "interactive" },
        ),
      ).rejects.toThrow("ENOENT");
    });
  });
});

async function collectTimelineText(events: AsyncGenerator<AgentStreamEvent>): Promise<string[]> {
  const text: string[] = [];
  for await (const event of events) {
    if (event.type !== "timeline") {
      continue;
    }
    if (event.item.type === "user_message" || event.item.type === "assistant_message") {
      text.push(`${event.item.type}:${event.item.text}`);
    }
  }
  return text;
}

async function withFakeACPAgent(
  run: (input: {
    command: [string, ...string[]];
    removedCwd: string;
    loadRequestsPath: string;
  }) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-archived-history-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    const loadRequestsPath = path.join(testDir, "load-requests.json");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run({
      command: [process.execPath, scriptPath, loadRequestsPath],
      removedCwd: path.join(testDir, "removed-worktree"),
      loadRequestsPath,
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const fs = require("node:fs");
const readline = require("node:readline");

const loadRequestsPath = process.argv[2];
const loadRequests = [];
const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function replay(sessionId, sessionUpdate, text) {
  write({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } },
  });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      },
    });
    return;
  }

  if (message.method === "session/load") {
    const { sessionId, cwd } = message.params;
    loadRequests.push({ sessionId, cwd });
    fs.writeFileSync(loadRequestsPath, JSON.stringify(loadRequests));
    replay(sessionId, "user_message_chunk", "What is in the README?");
    replay(sessionId, "agent_message_chunk", "It describes the project.");
    write({ id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
