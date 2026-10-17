import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createCodexArchiveContextFixture } from "./test-utils/codex-archive-context.js";
import { fetchTimelineItems, textByRole } from "./test-utils/rewind-helpers.js";

// Uses the existing local Codex account in a disposable home. No auth preflight,
// alternate account fallback, or login: missing/expired credentials fail normally.
test("custom Codex archive smoke restores fresh context after daemon restarts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-live-archive-"));
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    const { codexHome, cwd, plugin, staticDir, launches, wrapper } =
      createCodexArchiveContextFixture(root);
    copyFileSync(
      path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json"),
      path.join(codexHome, "auth.json"),
    );
    chmodSync(path.join(codexHome, "auth.json"), 0o600);
    const options: Parameters<typeof createTestPaseoDaemon>[0] = {
      paseoHomeRoot: path.join(root, "daemon"),
      staticDir,
      cleanup: false,
      pluginsEnabled: true,
      plugins: { "archive-context": { source: "directory", path: plugin, enabled: true } },
      providerOverrides: {
        "context-codex": {
          extends: "codex",
          label: "Context Codex",
          command: [process.execPath, wrapper],
          env: { CODEX_HOME: codexHome },
        },
      },
    };
    async function startDaemon() {
      daemon = await createTestPaseoDaemon(options);
      client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.11.2",
      });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      return client;
    }
    async function restartDaemon() {
      await client?.close();
      await daemon?.close();
      return startDaemon();
    }
    let connected = await startDaemon();
    const catalog = await connected.listProviderModels("context-codex", { cwd });
    const model = catalog.models.find((entry) => entry.isDefault);
    if (!model) throw new Error("Codex did not return a default model");
    const agent = await connected.createAgent({
      config: {
        provider: "context-codex",
        cwd,
        model: model.id,
        modeId: "auto",
        thinkingOptionId: "low",
      },
    });
    const token = "ARCHIVE_CEDAR_7429";
    await connected.sendMessage(
      agent.id,
      `Remember ${token}. Reply with only that token. Do not use tools.`,
    );
    const first = await connected.waitForFinish(agent.id, 90_000);
    expect(first.status).toBe("idle");
    expect(first.final?.lastError).toBeUndefined();
    expect(
      textByRole(await fetchTimelineItems(connected, agent.id), "assistant_message"),
    ).toContain(token);
    const initial = (await connected.fetchAgent(agent.id))!.agent;
    const sessionId = initial.persistence?.sessionId;
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    process.stdout.write("PASS initial live-provider turn completed\n");

    connected = await restartDaemon();
    await connected.archiveAgent(agent.id);
    const archived = (await connected.fetchAgent(agent.id))!.agent;
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(archived.persistence?.sessionId).toBe(sessionId);
    const nativeArchives = readdirSync(path.join(codexHome, "archived_sessions"));
    expect(nativeArchives).toHaveLength(1);
    expect(nativeArchives[0]).toContain(sessionId);
    process.stdout.write("PASS native archive after first daemon restart; identity preserved\n");

    connected = await restartDaemon();
    expect((await connected.fetchAgent(agent.id))!.agent.archivedAt).toBe(archived.archivedAt);
    await connected.refreshAgent(agent.id);
    const restored = (await connected.fetchAgent(agent.id))!.agent;
    expect(restored.archivedAt).toBeNull();
    expect(restored.persistence?.sessionId).toBe(sessionId);
    expect(readdirSync(path.join(codexHome, "archived_sessions"))).toEqual([]);
    process.stdout.write(
      "PASS native restore after second daemon restart; archive flags cleared\n",
    );

    await connected.sendMessage(
      agent.id,
      "What token did I ask you to remember? Reply with RECALLED=<token>. Do not use tools.",
    );
    const followUp = await connected.waitForFinish(agent.id, 90_000);
    expect(followUp.status).toBe("idle");
    expect(followUp.final?.lastError).toBeUndefined();
    const timeline = await fetchTimelineItems(connected, agent.id);
    expect(textByRole(timeline, "assistant_message")).toContain(`RECALLED=${token}`);
    expect(timeline.filter((item) => item.type === "user_message")).toHaveLength(2);
    expect(timeline.filter((item) => item.type === "tool_call")).toEqual([]);
    const final = (await connected.fetchAgent(agent.id))!.agent;
    expect(final).toMatchObject({
      id: agent.id,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      provider: "context-codex",
    });
    expect(final.persistence?.sessionId).toBe(sessionId);
    process.stdout.write("PASS follow-up recalled initial token in the same native conversation\n");

    const launchSchema = z.object({
      method: z.string(),
      valid: z.boolean(),
      reason: z.string(),
      purpose: z.string(),
      generation: z.string().uuid(),
      workspaceId: z.string(),
      agentId: z.string(),
      cwd: z.string(),
      provider: z.string(),
      threadId: z.string().optional(),
    });
    const operations = readFileSync(launches, "utf8")
      .trim()
      .split("\n")
      .map((line) => launchSchema.parse(JSON.parse(line)));
    for (const operation of operations) {
      expect(operation).toMatchObject({
        valid: true,
        agentId: agent.id,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        provider: "context-codex",
      });
    }
    const start = operations.filter((entry) => entry.method === "thread/start");
    const archive = operations.filter((entry) => entry.method === "thread/archive");
    const restore = operations.filter((entry) => entry.method === "thread/unarchive");
    const resume = operations.filter((entry) => entry.method === "thread/resume");
    expect(start).toHaveLength(1);
    expect(archive).toHaveLength(1);
    expect(restore).toHaveLength(1);
    expect(resume).toHaveLength(1);
    expect(archive[0]).toMatchObject({
      reason: "archive",
      purpose: "maintenance",
      threadId: sessionId,
    });
    expect(restore[0]).toMatchObject({
      reason: "restore",
      purpose: "maintenance",
      threadId: sessionId,
    });
    expect(resume[0]).toMatchObject({ threadId: sessionId, generation: restore[0].generation });
    expect(new Set([start[0].generation, archive[0].generation, restore[0].generation]).size).toBe(
      3,
    );
    expect(JSON.stringify(await daemon!.daemon.agentStorage.get(agent.id))).not.toContain(
      "SESSION_GENERATION",
    );
    process.stdout.write(
      "PASS fresh per-agent context on create/archive/restore; no persisted launch environment\n",
    );
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await daemon?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
        process.stdout.write("PASS removed test-owned state, including temporary credentials\n");
      }
    }
  }
}, 240_000);

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
    await client.fetchAgents({ subscribe: {} });
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
