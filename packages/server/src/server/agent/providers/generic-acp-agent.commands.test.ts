import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient slash commands", () => {
  test("lists commands an agent advertises right after session/new", async () => {
    await withFakeACPAgent("commands-after-session-new", async (command, cwd) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        // Long enough that the update always lands inside the wait, however slowly
        // the fake agent is scheduled.
        initialCommandsWaitTimeoutMs: 60_000,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        await expect(session.listCommands?.()).resolves.toEqual([
          { name: "review", description: "Review the diff", argumentHint: "", kind: "command" },
        ]);
      } finally {
        await session.close();
      }
    });
  });

  test("answers with no commands for an agent that never advertises any", async () => {
    await withFakeACPAgent("silent", async (command, cwd) => {
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 50,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        await expect(session.listCommands?.()).resolves.toEqual([]);
      } finally {
        await session.close();
      }
    });
  });
});

async function withFakeACPAgent(
  mode: "commands-after-session-new" | "silent",
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-commands-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath, mode], testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const readline = require("node:readline");

const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      },
    });
    return;
  }

  if (message.method === "session/new") {
    write({ id: message.id, result: { sessionId: "session-1" } });
    if (mode === "commands-after-session-new") {
      setTimeout(() => {
        write({
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "review", description: "Review the diff" }],
            },
          },
        });
      }, 0);
    }
    return;
  }

  if (message.id !== undefined) {
    write({ id: message.id, result: {} });
  }
});
`;
