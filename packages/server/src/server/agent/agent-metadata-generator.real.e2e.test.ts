import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import pino from "pino";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { shutdownProviders } from "./provider-registry.js";
import { generateAndApplyAgentMetadata } from "./agent-metadata-generator.js";
import { OpenCodeServerManager } from "./providers/opencode/server-manager.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "../daemon-e2e/real-provider-test-config.js";

const CODEX_TEST_MODEL = getRealProviderConfig("codex").model;
const CODEX_TEST_THINKING_OPTION_ID = getRealProviderConfig("codex").thinkingOptionId;
const CLAUDE_TEST_MODEL = getRealProviderConfig("claude").model;
const OPENCODE_TEST_MODEL = getRealProviderConfig("opencode").model;

function collectFilesRecursively(root: string, filter: (name: string) => boolean): Set<string> {
  const results = new Set<string>();
  try {
    statSync(root);
  } catch {
    return results;
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && filter(entry.name)) {
        results.add(full);
      }
    }
  }
  return results;
}

function collectCodexRolloutFiles(): Set<string> {
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return collectFilesRecursively(path.join(codexHome, "sessions"), (name) =>
    name.startsWith("rollout-"),
  );
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function collectClaudeProjectFiles(cwd: string): Set<string> {
  const dir = path.join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwd));
  return collectFilesRecursively(dir, (name) => name.endsWith(".jsonl"));
}

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe("agent metadata generation (real agents)", () => {
  const logger = pino({ level: "silent" });
  let cwd: string;
  let paseoHome: string;
  let manager: AgentManager;
  let storage: AgentStorage;
  let codexAvailable = false;
  let claudeAvailable = false;
  let opencodeAvailable = false;

  beforeAll(async () => {
    [codexAvailable, claudeAvailable, opencodeAvailable] = await Promise.all([
      canRunRealProvider("codex"),
      canRunRealProvider("claude"),
      canRunRealProvider("opencode"),
    ]);
  });

  beforeEach(() => {
    cwd = tmpCwd("metadata-cwd-");
    paseoHome = tmpCwd("metadata-paseo-home-");
    storage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    manager = new AgentManager({
      clients: createRealProviderClients(["codex", "claude", "opencode"], logger),
      registry: storage,
      logger,
    });
  });

  afterEach(async () => {
    await shutdownProviders(logger);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(paseoHome, { recursive: true, force: true });
  }, 60000);

  test("generates a title using a real Codex agent without persisting a rollout", async (ctx) => {
    if (!codexAvailable) {
      ctx.skip();
    }
    const agent = await manager.createAgent(
      {
        provider: "codex",
        model: CODEX_TEST_MODEL,
        ...(CODEX_TEST_THINKING_OPTION_ID
          ? { thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID }
          : {}),
        modeId: "auto",
        cwd: cwd,
        title: "Main Agent",
      },
      "4e0a4508-e522-4fe9-8384-cf3bf889f16d",
    );

    const rolloutsBefore = collectCodexRolloutFiles();

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: agent.id,
      cwd: cwd,
      initialPrompt: "Use the exact title 'Metadata Title E2E'.",
      explicitTitle: null,
      paseoHome,
      logger,
    });

    await storage.flush();
    const record = await storage.get(agent.id);
    expect(record?.title).toBe("Metadata Title E2E");

    const rolloutsAfter = collectCodexRolloutFiles();
    const newRollouts = [...rolloutsAfter].filter((file) => !rolloutsBefore.has(file));
    expect(newRollouts).toEqual([]);

    await manager.closeAgent(agent.id);
  }, 180000);

  test("generates a title using a real Claude agent without persisting a session", async (ctx) => {
    if (!claudeAvailable) {
      ctx.skip();
    }
    const agent = await manager.createAgent(
      {
        provider: "claude",
        model: CLAUDE_TEST_MODEL,
        thinkingOptionId: "on",
        cwd: cwd,
        title: "Main Claude Agent",
      },
      "5e1b5619-f633-5fea-9495-d04bf990f27e",
    );

    const sessionsBefore = collectClaudeProjectFiles(cwd);

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: agent.id,
      cwd: cwd,
      initialPrompt: "Use the exact title 'Claude Metadata Title'.",
      explicitTitle: null,
      paseoHome,
      logger,
    });

    await storage.flush();
    const record = await storage.get(agent.id);
    expect(record?.title).toBe("Claude Metadata Title");

    const sessionsAfter = collectClaudeProjectFiles(cwd);
    const newSessions = [...sessionsAfter].filter((file) => !sessionsBefore.has(file));
    expect(newSessions).toEqual([]);

    await manager.closeAgent(agent.id);
  }, 180000);

  test("generates a title using a real OpenCode agent and deletes the ephemeral session", async (ctx) => {
    if (!opencodeAvailable) {
      ctx.skip();
    }
    const agent = await manager.createAgent(
      {
        provider: "opencode",
        model: OPENCODE_TEST_MODEL,
        modeId: "build",
        cwd: cwd,
        title: "Main OpenCode Agent",
      },
      "6e2c6720-e744-6fdb-a5a6-e15cf0a1f380",
    );

    const acquisition = await OpenCodeServerManager.getInstance(logger).acquire({ force: false });
    const inspectClient = createOpencodeClient({
      baseUrl: acquisition.server.url,
      directory: cwd,
    });
    try {
      const sessionsBeforeRes = await inspectClient.session.list({ directory: cwd });
      const sessionIdsBefore = new Set((sessionsBeforeRes.data ?? []).map((session) => session.id));

      await generateAndApplyAgentMetadata({
        agentManager: manager,
        agentId: agent.id,
        cwd: cwd,
        initialPrompt: "Use the exact title 'OpenCode Metadata Title'.",
        explicitTitle: null,
        paseoHome,
        logger,
      });

      await storage.flush();
      const record = await storage.get(agent.id);
      expect(record?.title).toBe("OpenCode Metadata Title");

      const sessionsAfterRes = await inspectClient.session.list({ directory: cwd });
      const newSessions = (sessionsAfterRes.data ?? []).filter(
        (session) => !sessionIdsBefore.has(session.id),
      );
      expect(newSessions).toEqual([]);
    } finally {
      acquisition.release();
      await manager.closeAgent(agent.id);
    }
  }, 180000);
});
