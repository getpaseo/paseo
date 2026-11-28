import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { KiroACPAgentClient } from "./kiro-acp-agent.js";

describe("KiroACPAgentClient session import", () => {
  test("lists sessions from the agent that Kiro runs when the client names no clientInfo", async () => {
    await withFakeKiroAgent(async (command) => {
      const client = new KiroACPAgentClient({
        logger: createTestLogger(),
        command,
        providerId: "kiro",
      });

      expect(await client.listImportableSessions()).toEqual([
        {
          providerHandleId: "sess_kiro-1",
          cwd: "/work/project",
          title: "Kiro session",
          firstPromptPreview: "what can you do",
          lastPromptPreview: "what can you do",
          lastActivityAt: new Date("2026-11-23T02:30:04.813Z"),
        },
      ]);
    });
  });

  test("a generic ACP client that sends clientInfo gets no importable sessions from Kiro", async () => {
    await withFakeKiroAgent(async (command) => {
      const client = new GenericACPAgentClient({ logger: createTestLogger(), command });

      expect(await client.listImportableSessions()).toEqual([]);
    });
  });
});

async function withFakeKiroAgent(run: (command: [string, ...string[]]) => Promise<void>) {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-kiro-import-"));
  try {
    const scriptPath = path.join(testDir, "fake-kiro-acp.cjs");
    await writeFile(scriptPath, fakeKiroAgentScript, "utf8");
    await run([process.execPath, scriptPath]);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

// Kiro CLI 3.x answers `initialize` with a minimal agent (no `session/list`) when the client
// sends `clientInfo`, and with the full agent when it does not.
const fakeKiroAgentScript = `
const readline = require("node:readline");
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
    const isFullAgent = message.params?.clientInfo === undefined;
    write({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: isFullAgent ? { list: {}, close: {} } : {},
        },
      },
    });
    return;
  }

  if (message.method === "session/list") {
    write({
      id: message.id,
      result: {
        sessions: [
          {
            sessionId: "sess_kiro-1",
            cwd: "/work/project",
            title: "Kiro session",
            updatedAt: "2026-11-23T02:30:04.813Z",
          },
        ],
      },
    });
    return;
  }

  if (message.method === "session/load") {
    const { sessionId } = message.params;
    replay(sessionId, "user_message_chunk", "what can you do");
    replay(sessionId, "agent_message_chunk", "A lot.");
    write({ id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
