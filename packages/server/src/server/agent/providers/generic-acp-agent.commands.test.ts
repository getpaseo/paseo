import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSession, AgentSlashCommand } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

// A generic provider that never sends available_commands_update must not block
// the palette request for this long; tests that use it would time out instead.
const NEVER_SETTLES_WAIT_MS = 60_000;
// Long enough to land after session/new resolves when the client is not
// already waiting, short enough to keep the waiting test fast.
const COMMANDS_AFTER_SESSION_NEW_DELAY_MS = 25;

type FakeACPAgentMode = "commands-after-session-new" | "silent";

describe("GenericACPAgentClient slash commands", () => {
  test("returns commands delivered by available_commands_update after session/new", async () => {
    await withFakeACPAgent("commands-after-session-new", async (command, testDir) => {
      const session = await createSession(command, testDir);

      try {
        await expect(listCommands(session)).resolves.toEqual([
          {
            name: "research_codebase",
            description: "Search the workspace for relevant files",
            argumentHint: "",
            kind: "command",
          },
          {
            name: "create_plan",
            description: "Draft a plan for the requested work",
            argumentHint: "",
            kind: "command",
          },
        ]);
      } finally {
        await session.close();
      }
    });
  });

  test("params.waitForInitialCommands false returns an empty palette without waiting", async () => {
    await withFakeACPAgent("silent", async (command, testDir) => {
      const session = await createSession(command, testDir, {
        providerParams: { waitForInitialCommands: false },
        initialCommandsWaitTimeoutMs: NEVER_SETTLES_WAIT_MS,
      });

      try {
        await expect(listCommands(session)).resolves.toEqual([]);
      } finally {
        await session.close();
      }
    });
  });

  test("the default wait settles with an empty palette when a provider never sends commands", async () => {
    await withFakeACPAgent("silent", async (command, testDir) => {
      const session = await createSession(command, testDir, {
        initialCommandsWaitTimeoutMs: 50,
      });

      try {
        await expect(listCommands(session)).resolves.toEqual([]);
      } finally {
        await session.close();
      }
    });
  });
});

async function createSession(
  command: [string, ...string[]],
  cwd: string,
  options: { providerParams?: unknown; initialCommandsWaitTimeoutMs?: number } = {},
): Promise<AgentSession> {
  const client = new GenericACPAgentClient({
    logger: createTestLogger(),
    command,
    providerParams: options.providerParams,
    initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
  });
  return client.createSession({ provider: "acp", cwd });
}

async function listCommands(session: AgentSession): Promise<AgentSlashCommand[]> {
  if (!session.listCommands) {
    throw new Error("Expected ACP sessions to expose listCommands()");
  }
  return session.listCommands();
}

async function withFakeACPAgent(
  mode: FakeACPAgentMode,
  run: (command: [string, ...string[]], testDir: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-commands-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run(
      [process.execPath, scriptPath, mode, String(COMMANDS_AFTER_SESSION_NEW_DELAY_MS)],
      testDir,
    );
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

// Minimal ACP agent over stdio. It answers initialize and session/new, then
// either reports slash commands after session/new resolves or stays silent, so
// Paseo's wait-for-initial-commands behavior is observable through
// createSession() and listCommands().
const fakeACPAgentScript = `
const readline = require("node:readline");

const mode = process.argv[2];
const commandDelayMs = Number(process.argv[3] || 0);
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? 1,
        agentCapabilities: {},
      },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      },
    });
    if (mode === "commands-after-session-new") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                {
                  name: "research_codebase",
                  description: "Search the workspace for relevant files",
                },
                {
                  name: "create_plan",
                  description: "Draft a plan for the requested work",
                },
              ],
            },
          },
        });
      }, commandDelayMs);
    }
    return;
  }

  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`;
