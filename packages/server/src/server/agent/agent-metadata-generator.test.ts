import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import pino from "pino";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createAllClients, shutdownProviders } from "./provider-registry.js";
import { generateAndApplyAgentMetadata } from "./agent-metadata-generator.js";
import { createWorktree, validateBranchSlug } from "../../utils/worktree.js";

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

const shouldRun = !process.env.CI && !!process.env.OPENAI_API_KEY;

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function initGitRepo(repoDir: string): void {
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'junction-test@example.com'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git config user.name 'Junction Test'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "pipe",
  });
}

(shouldRun ? describe : describe.skip)("agent metadata generation (real agents)", () => {
  const logger = pino({ level: "silent" });
  let repoDir: string;
  let junctionHome: string;
  let storagePath: string;
  let manager: AgentManager;
  let storage: AgentStorage;
  let codexSessionDir: string;
  let previousCodexSessionDir: string | undefined;

  beforeEach(() => {
    repoDir = tmpCwd("metadata-repo-");
    initGitRepo(repoDir);
    junctionHome = tmpCwd("metadata-junction-home-");
    storagePath = path.join(junctionHome, "agents");
    storage = new AgentStorage(storagePath, logger);
    manager = new AgentManager({
      clients: createAllClients(logger),
      registry: storage,
      logger,
    });
    codexSessionDir = tmpCwd("codex-sessions-");
    previousCodexSessionDir = process.env.CODEX_SESSION_DIR;
    process.env.CODEX_SESSION_DIR = codexSessionDir;
  });

  afterEach(async () => {
    process.env.CODEX_SESSION_DIR = previousCodexSessionDir;
    await shutdownProviders(logger);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(junctionHome, { recursive: true, force: true });
    rmSync(codexSessionDir, { recursive: true, force: true });
  }, 60000);

  test(
    "generates a title using a real Codex agent",
    async () => {
      const agent = await manager.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        modeId: "auto",
        cwd: repoDir,
        title: "Main Agent",
      }, "4e0a4508-e522-4fe9-8384-cf3bf889f16d");

      await generateAndApplyAgentMetadata({
        agentManager: manager,
        agentId: agent.id,
        cwd: repoDir,
        initialPrompt: "Use the exact title 'Metadata Title E2E'.",
        explicitTitle: null,
        junctionHome,
        logger,
      });

      await storage.flush();
      const record = await storage.get(agent.id);
      expect(record?.title).toBe("Metadata Title E2E");

      await manager.closeAgent(agent.id);
    },
    180000
  );

  test(
    "renames the worktree branch using a real Codex agent",
    async () => {
      const worktreeSlug = "metadata-worktree";
      const worktree = await createWorktree({
        branchName: worktreeSlug,
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug,
        junctionHome,
      });

      const agent = await manager.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        modeId: "auto",
        cwd: worktree.worktreePath,
        title: "Worktree Agent",
      }, "32bb765d-f637-44a2-9820-f2efd5261418");

      await generateAndApplyAgentMetadata({
        agentManager: manager,
        agentId: agent.id,
        cwd: worktree.worktreePath,
        initialPrompt: "Use the exact branch 'feat/metadata-worktree'.",
        explicitTitle: "Explicit Title",
        junctionHome,
        logger,
      });

      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      }).toString().trim();

      const validation = validateBranchSlug(currentBranch);
      expect(validation.valid).toBe(true);
      expect(currentBranch).toBe("feat/metadata-worktree");

      await manager.closeAgent(agent.id);
    },
    180000
  );
});
