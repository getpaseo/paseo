import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient slash commands", () => {
  test("preserves argument hints in commands advertised right after session/new", async () => {
    await withFakeACPAgent("commands-after-session-new", async (command, cwd) => {
      await withIsolatedHome(async (home) => {
        const client = new GenericACPAgentClient({
          logger: createTestLogger(),
          command,
          initialCommandsWaitTimeoutMs: 1_500,
          homeDir: home,
        });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          const commands = [
            {
              name: "review",
              description: "Review the diff",
              argumentHint: "query",
              kind: "command",
            },
            { name: "status", description: "Show status", argumentHint: "", kind: "command" },
          ];
          await expect(session.listCommands?.()).resolves.toEqual(commands);
          await expect(session.listCommands?.()).resolves.toEqual(commands);
        } finally {
          await session.close();
        }
      });
    });
  });

  test("answers with no commands for an agent that never advertises any", async () => {
    await withFakeACPAgent("silent", async (command, cwd) => {
      await withIsolatedHome(async (home) => {
        const client = new GenericACPAgentClient({
          logger: createTestLogger(),
          command,
          initialCommandsWaitTimeoutMs: 50,
          homeDir: home,
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
});

/**
 * Runs the body with an empty fixture home.
 *
 * Skill discovery reads the user's home, so a test that asserts an exact
 * command list has to point the session at a home it controls: the machine's
 * own `~/.agents/skills` would otherwise leak into the assertion.
 */
async function withIsolatedHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-acp-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

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

const state = { id: 0 };
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  const method = frame.method ?? "";
  if (method === "initialize") {
    reply(frame.id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-acp", title: "Fake ACP" },
      agentCapabilities: { promptCapabilities: { listCommands: true } },
    });
    return;
  }
  if (method === "session/new") {
    const sessionId = "sess-" + ++state.id;
    reply(frame.id, { sessionId, modes: [], configOptions: [] });
    if (process.argv[2] === "commands-after-session-new") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "review", description: "Review the diff", input: { hint: "query" } },
                { name: "status", description: "Show status" },
              ],
            },
          },
        });
      }, 0);
    }
    return;
  }
  if (frame.id !== undefined) {
    reply(frame.id, {});
  }
});
`;
