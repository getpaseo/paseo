import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function createRepo(prefix: string): { root: string; cwd: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const cwd = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", cwd]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "QA",
    ],
    { cwd },
  );
  return { root, cwd };
}

test("Claude Code surfaces its predicted next prompt on the idle agent snapshot", async () => {
  // Claude Code backs off after suggestions go unused, which every test run does; keep them on.
  const previousSuggestionEnv = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION;
  process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "true";
  const { root, cwd } = createRepo("paseo-prompt-suggestion-claude-");
  const logger = pino({ level: "warn" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { claude: new ClaudeAgentClient({ logger }) },
    logger,
    pluginsEnabled: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "claude", cwd, modeId: "default" });

    // Claude suppresses suggestions on the first turn, so run two short turns.
    await client.sendMessage(
      agent.id,
      "We are planning a tiny Python CLI that prints the weather. Reply with one sentence. Do not use tools.",
    );
    expect((await client.waitForFinish(agent.id, 180_000)).status).toBe("idle");
    await client.sendMessage(
      agent.id,
      "Name the first file we should create for it. Reply with one sentence. Do not use tools.",
    );
    const finished = await client.waitForFinish(agent.id, 180_000);
    expect(finished.status).toBe("idle");

    // The suggestion arrives after the turn ends, as an in-place agent state update.
    const withSuggestion = await client.waitForAgentUpsert(
      agent.id,
      (snapshot) =>
        snapshot.status === "idle" &&
        typeof snapshot.promptSuggestion === "string" &&
        snapshot.promptSuggestion.trim().length > 0,
      90_000,
    );
    // Raw evidence for QA: the provider's predicted next prompt.
    process.stdout.write(
      `[claude] promptSuggestion=${JSON.stringify(withSuggestion.promptSuggestion)}\n`,
    );

    // Starting the next turn clears it before the agent reports running work.
    await client.sendMessage(agent.id, "Thanks. Reply with OK. Do not use tools.");
    const running = await client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "running",
      60_000,
    );
    expect(running.promptSuggestion ?? null).toBeNull();
    expect((await client.waitForFinish(agent.id, 180_000)).status).toBe("idle");
  } finally {
    await client.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
    if (previousSuggestionEnv === undefined) {
      delete process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION;
    } else {
      process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = previousSuggestionEnv;
    }
  }
}, 600_000);
