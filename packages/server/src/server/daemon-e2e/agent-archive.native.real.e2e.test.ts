import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

async function expectContextAfterWorkspaceRestore(legacyNativeArchive: boolean): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-archive-codex-"));
  const cwd = path.join(root, "repo");
  mkdirSync(cwd);
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
  const logger = pino({ level: "warn" });
  const provider = new CodexAppServerAgentClient(logger);
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      agentClients: { codex: provider },
      logger,
      pluginsEnabled: false,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "archive-qa" } });
    const agent = await client.createAgent({
      config: {
        provider: "codex",
        cwd,
        model: "gpt-5.6-sol",
        modeId: "full-access",
        thinkingOptionId: "low",
      },
      worktree: { mode: "branch-off", base: "main", newBranch: "archive-qa" },
    });
    const manager = daemon.daemon.agentManager;
    const token = "ARCHIVE_CEDAR_7429";
    const first = await manager.runAgent(
      agent.id,
      `Remember ${token}. Reply with only that token. Do not use tools.`,
    );
    expect(first.finalText).toContain(token);
    const handle = manager.getAgent(agent.id)!.persistence!;
    await client.archiveWorkspace(agent.workspaceId!);
    expect(existsSync(agent.cwd)).toBe(false);
    // Older daemons marked Paseo archived while native archive failed against its writer.
    if (legacyNativeArchive) await provider.unarchiveNativeSession(handle);
    await client.restoreWorkspace(agent.workspaceId!);
    expect(existsSync(agent.cwd)).toBe(true);
    await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    await client.sendAgentMessage(
      agent.id,
      "What token did I ask you to remember? Reply with RECALLED=<token>. Do not use tools.",
      { activeTurnBehavior: "steer" },
    );
    const connectedClient = client;
    await expect
      .poll(
        async () => {
          const timeline = await connectedClient.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          return timeline.entries
            .map(({ item }) => (item.type === "assistant_message" ? item.text : ""))
            .join("");
        },
        { timeout: 30_000 },
      )
      .toContain(`RECALLED=${token}`);
    expect(manager.getAgent(agent.id)?.persistence?.sessionId).toBe(handle.sessionId);
    process.stdout.write(
      `archived -> restored; same agent=${agent.id}; same session=${handle.sessionId}; two real replies recall ${token}; legacy=${legacyNativeArchive}\n`,
    );
    await client.archiveWorkspace(agent.workspaceId!);
  } finally {
    await client?.close();
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Opt in: real Codex requests using local authentication.
test.runIf(process.env.PASEO_NATIVE_ARCHIVE_QA === "1").each([false, true])(
  "Codex recalls context after workspace restore (legacy native archive: %s)",
  async (legacyNativeArchive) => {
    await expectContextAfterWorkspaceRestore(legacyNativeArchive);
  },
  90_000,
);
