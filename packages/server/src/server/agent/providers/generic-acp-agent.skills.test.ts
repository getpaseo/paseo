import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient skill discovery", () => {
  test("offers AGENTS.md skills the agent does not advertise itself", async () => {
    await withFakeACPAgent("silent", async (command, cwd, home) => {
      // The workspace and the fixture home each hold one AGENTS.md skill. The
      // agent under test advertises neither, which is what an agent that
      // reads only its own skill directory does.
      await writeSkill(path.join(cwd, ".agents", "skills", "deploy-notes"));
      await writeSkill(path.join(cwd, ".claude", "skills", "review-checklist"));
      await writeSkill(path.join(home, ".agents", "skills", "user-notes"));
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 50,
        homeDir: home,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        const commands = await session.listCommands!();
        expect(commandNames(commands)).toEqual(["deploy-notes", "review-checklist", "user-notes"]);
      } finally {
        await session.close();
      }
    });
  });

  test("a skill the agent advertises itself is not duplicated", async () => {
    await withFakeACPAgent("commands-after-session-new", async (command, cwd, home) => {
      await writeSkill(path.join(cwd, ".agents", "skills", "review"));
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 1_500,
        homeDir: home,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        const commands = await session.listCommands!();
        expect(commands).toHaveLength(1);
        expect(commands[0]?.name).toBe("review");
        expect(commands[0]?.kind).toBe("command");
      } finally {
        await session.close();
      }
    });
  });

  test("caches an empty skill scan instead of rescanning on every call", async () => {
    await withFakeACPAgent("silent", async (command, cwd, home) => {
      // No skill directories exist yet, so the first scan finds nothing. A
      // later skill must not show up: the scan ran once and its empty result
      // is the answer.
      const skillsDir = path.join(cwd, ".agents", "skills");
      await mkdir(skillsDir, { recursive: true });
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 50,
        homeDir: home,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        expect(await session.listCommands!()).toHaveLength(0);
        await writeSkill(path.join(skillsDir, "late-skill"));
        expect(await session.listCommands!()).toHaveLength(0);
      } finally {
        await session.close();
      }
    });
  });

  test("leaves a command the agent advertises later for the agent to run", async () => {
    await withFakeACPAgent("late-commands", async (command, cwd, home) => {
      // A skill named `review` sits on disk, and the agent advertises its own
      // `review` command a moment after the session starts. The agent owns
      // that name, so Paseo must send the prompt unchanged instead of
      // expanding the local skill over it.
      await writeSkill(path.join(cwd, ".agents", "skills", "review"));
      const promptLog = path.join(cwd, "prompt-log.txt");
      process.env.FAKE_ACP_PROMPT_LOG = promptLog;
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 1_500,
        homeDir: home,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      try {
        await session.startTurn("/review the diff");
        await waitForFile(promptLog);
        const received = readFileSync(promptLog, "utf8");
        expect(received).toContain("/review the diff");
        expect(received).not.toContain("<skill");
      } finally {
        delete process.env.FAKE_ACP_PROMPT_LOG;
        await session.close();
      }
    });
  });

  test("does not start work when the turn is stopped before the prompt is sent", async () => {
    await withFakeACPAgent("late-commands", async (command, cwd, home) => {
      // The agent publishes its commands a moment late, so the turn waits for
      // the command inventory before it can send the prompt. A stop during
      // that wait must not end with the prompt being sent anyway.
      await writeSkill(path.join(cwd, ".agents", "skills", "late-skill"));
      const promptLog = path.join(cwd, "prompt-log.txt");
      process.env.FAKE_ACP_PROMPT_LOG = promptLog;
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command,
        initialCommandsWaitTimeoutMs: 1_500,
        homeDir: home,
      });
      const session = await client.createSession({ provider: "acp", cwd });
      const events = collectEvents(session);
      try {
        // `startTurn` waits for the command inventory before it sends the
        // prompt, so the stop has to land inside that wait.
        const turnPromise = session.startTurn("/late-skill do it");
        await session.interrupt();
        const turn = await turnPromise;
        // Give the turn time to reach the point where it would send the
        // prompt.
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(existsSync(promptLog)).toBe(false);
        expect(events).toContainEqual(
          expect.objectContaining({ type: "turn_canceled", turnId: turn.turnId }),
        );
      } finally {
        delete process.env.FAKE_ACP_PROMPT_LOG;
        await session.close();
      }
    });
  });
});

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the fake agent to receive the prompt");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function collectEvents(session: {
  subscribe(callback: (event: { type: string }) => void): () => void;
}) {
  const events: { type: string }[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function commandNames(commands: { name: string }[]): string[] {
  return commands.map((command) => command.name);
}

async function writeSkill(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    "---\ndescription: Test skill\n---\nBody of the test skill.\n",
    "utf8",
  );
}

async function withFakeACPAgent(
  mode: "commands-after-session-new" | "late-commands" | "silent",
  run: (command: [string, ...string[]], cwd: string, home: string) => Promise<void>,
): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "paseo-acp-skills-"));
  const home = await mkdtemp(path.join(tmpdir(), "paseo-acp-home-"));
  try {
    const scriptPath = path.join(testDir, "fake-acp-agent.cjs");
    await writeFile(scriptPath, fakeACPAgentScript, "utf8");
    await run([process.execPath, scriptPath, mode], testDir, home);
  } finally {
    await rm(testDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

const fakeACPAgentScript = `
const fs = require("node:fs");
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
    if (process.argv[2] === "commands-after-session-new" || process.argv[2] === "late-commands") {
      const delay = process.argv[2] === "late-commands" ? 250 : 0;
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
      }, delay);
    }
    return;
  }
  if (method === "session/prompt") {
    // Record what the agent actually received so the test can assert that
    // Paseo did not rewrite the prompt.
    const logPath = process.env.FAKE_ACP_PROMPT_LOG;
    if (logPath) {
      const blocks = (frame.params && frame.params.prompt) || [];
      const text = blocks
        .map((block) => (block && block.text) || "")
        .join("\\n");
      fs.appendFileSync(logPath, text + "\\n");
    }
    reply(frame.id, { stopReason: "end_turn" });
    return;
  }
  if (frame.id !== undefined) {
    reply(frame.id, {});
  }
});
`;
