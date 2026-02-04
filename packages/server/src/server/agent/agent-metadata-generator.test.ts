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

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function initGitRepo(repoDir: string): void {
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'paseo-test@example.com'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git config user.name 'Paseo Test'", {
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

describe("agent metadata generation (real agents)", () => {
  const logger = pino({ level: "silent" });
  let repoDir: string;
  let paseoHome: string;
  let storagePath: string;
  let manager: AgentManager;
  let storage: AgentStorage;
  let codexSessionDir: string;
  let previousCodexSessionDir: string | undefined;

  beforeEach(() => {
    repoDir = tmpCwd("metadata-repo-");
    initGitRepo(repoDir);
    paseoHome = tmpCwd("metadata-paseo-home-");
    storagePath = path.join(paseoHome, "agents");
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
    rmSync(paseoHome, { recursive: true, force: true });
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
      }, "metadata-title-agent");

      await generateAndApplyAgentMetadata({
        agentManager: manager,
        agentId: agent.id,
        cwd: repoDir,
        initialPrompt: "Use the exact title 'Metadata Title E2E'.",
        explicitTitle: null,
        paseoHome,
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
        paseoHome,
      });

      const agent = await manager.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        modeId: "auto",
        cwd: worktree.worktreePath,
        title: "Worktree Agent",
      }, "metadata-branch-agent");

      await generateAndApplyAgentMetadata({
        agentManager: manager,
        agentId: agent.id,
        cwd: worktree.worktreePath,
        initialPrompt: "Use the exact branch 'feat/metadata-worktree'.",
        explicitTitle: "Explicit Title",
        paseoHome,
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
