import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient skill discovery", () => {
  test("offers AGENTS.md skills the agent does not advertise itself", async () => {
    await withFakeACPAgent("silent", async (command, cwd) => {
      // The workspace and the fixture home each hold one AGENTS.md skill. The
      // agent under test advertises neither, which is what an agent that
      // reads only its own skill directory does.
      await writeSkill(path.join(cwd, ".agents", "skills", "deploy-notes"));
      await writeSkill(path.join(cwd, ".claude", "skills", "review-checklist"));
      const home = await mkdtemp(path.join(tmpdir(), "paseo-acp-home-"));
      try {
        await writeSkill(path.join(home, ".agents", "skills", "user-notes"));
        const client = new GenericACPAgentClient({
          logger: createTestLogger(),
          command,
          initialCommandsWaitTimeoutMs: 50,
          homeDir: home,
        });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          const names = (await session.listCommands?.()).map((c) => c.name);
          expect(names).toEqual(["deploy-notes", "review-checklist", "user-notes"]);
        } finally {
          await session.close();
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  test("a skill the agent advertises itself is not duplicated", async () => {
    await withFakeACPAgent("commands-after-session-new", async (command, cwd) => {
      await writeSkill(path.join(cwd, ".agents", "skills", "review"));
      const home = await mkdtemp(path.join(tmpdir(), "paseo-acp-home-"));
      try {
        const client = new GenericACPAgentClient({
          logger: createTestLogger(),
          command,
          initialCommandsWaitTimeoutMs: 1_500,
          homeDir: home,
        });
        const session = await client.createSession({ provider: "acp", cwd });
        try {
          const commands = await session.listCommands?.();
          expect(commands).toHaveLength(1);
          expect(commands[0]?.name).toBe("review");
          expect(commands[0]?.kind).toBe("command");
        } finally {
          await session.close();
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });
});

async function writeSkill(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    "---\ndescription: Test skill\n---\nBody of the test skill.\n",
    "utf8",
  );
}

async function withFakeACPAgent(
  mode: "commands-after-session-new" | "silent",
  run: (command: [string, ...string[]], cwd: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-skills-"));
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
                { name: "review", description: "Review the diff" },
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
