import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentSelfIdMcpServer } from "./agent-self-id-mcp.js";
import { createWorktree } from "../../utils/worktree.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class TestAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new TestAgentSession(config);
  }

  async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
    return new TestAgentSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }
}

class TestAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async *stream(): AsyncGenerator<AgentStreamEvent> {
    yield { type: "turn_started", provider: this.provider };
    yield { type: "turn_completed", provider: this.provider };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

function initGitRepo(repoDir: string): void {
  execSync("git init -b main", { cwd: repoDir, stdio: "ignore" });
  execSync('git config user.email "paseo-test@example.com"', {
    cwd: repoDir,
    stdio: "ignore",
  });
  execSync('git config user.name "Paseo Test"', {
    cwd: repoDir,
    stdio: "ignore",
  });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: repoDir, stdio: "ignore" });
}

describe("self-identification MCP tools", () => {
  const logger = createTestLogger();

  test("set_branch renames branch for Paseo worktree", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-self-ident-"));
    const paseoHome = path.join(repoDir, "paseo-home");

    try {
      initGitRepo(repoDir);
      const worktree = await createWorktree({
        branchName: "self-ident",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "self-ident",
        paseoHome,
      });

      const storagePath = path.join(repoDir, "agents");
      const storage = new AgentStorage(storagePath, logger);
      const manager = new AgentManager({
        clients: { codex: new TestAgentClient() },
        registry: storage,
        logger,
        idFactory: () => "agent-self-ident",
      });

      const agent = await manager.createAgent({
        provider: "codex",
        cwd: worktree.worktreePath,
      });

      const server = await createAgentSelfIdMcpServer({
        agentManager: manager,
        paseoHome,
        callerAgentId: agent.id,
        logger,
      });
      const tool = (server as any)._registeredTools["set_branch"];

      await tool.callback({ name: "self-ident-ready" });

      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();

      expect(branch).toBe("self-ident-ready");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("set_branch allows agents running in a subdirectory of a Paseo worktree", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-self-ident-"));
    const paseoHome = path.join(repoDir, "paseo-home");

    try {
      initGitRepo(repoDir);
      const worktree = await createWorktree({
        branchName: "self-ident-subdir",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "self-ident-subdir",
        paseoHome,
      });
      const nestedDir = path.join(worktree.worktreePath, "nested");
      execSync(`mkdir -p "${nestedDir}"`, { stdio: "ignore" });

      const storagePath = path.join(repoDir, "agents");
      const storage = new AgentStorage(storagePath, logger);
      const manager = new AgentManager({
        clients: { codex: new TestAgentClient() },
        registry: storage,
        logger,
        idFactory: () => "agent-self-ident-subdir",
      });

      const agent = await manager.createAgent({
        provider: "codex",
        cwd: nestedDir,
      });

      const server = await createAgentSelfIdMcpServer({
        agentManager: manager,
        paseoHome,
        callerAgentId: agent.id,
        logger,
      });
      const tool = (server as any)._registeredTools["set_branch"];

      await tool.callback({ name: "self-ident-subdir-ready" });

      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: nestedDir,
        stdio: "pipe",
      })
        .toString()
        .trim();

      expect(branch).toBe("self-ident-subdir-ready");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("set_branch rejects subsequent renames after initial rename", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-self-ident-"));
    const paseoHome = path.join(repoDir, "paseo-home");

    try {
      initGitRepo(repoDir);
      const worktree = await createWorktree({
        branchName: "initial-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "initial-branch",
        paseoHome,
      });

      const storagePath = path.join(repoDir, "agents");
      const storage = new AgentStorage(storagePath, logger);
      const manager = new AgentManager({
        clients: { codex: new TestAgentClient() },
        registry: storage,
        logger,
        idFactory: () => "agent-subsequent-rename",
      });

      const agent = await manager.createAgent({
        provider: "codex",
        cwd: worktree.worktreePath,
      });

      const server = await createAgentSelfIdMcpServer({
        agentManager: manager,
        paseoHome,
        callerAgentId: agent.id,
        logger,
      });
      const tool = (server as any)._registeredTools["set_branch"];

      // First rename should succeed
      await tool.callback({ name: "first-rename" });

      const branchAfterFirst = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(branchAfterFirst).toBe("first-rename");

      // Second rename should fail
      await expect(tool.callback({ name: "second-rename" })).rejects.toMatchObject({
        code: "NOT_ALLOWED",
        message: expect.stringContaining("already been renamed"),
      });

      // Branch should still be first-rename
      const branchAfterSecond = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(branchAfterSecond).toBe("first-rename");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("set_branch rejects non-Paseo checkouts", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-self-ident-"));

    try {
      initGitRepo(repoDir);
      const storagePath = path.join(repoDir, "agents");
      const storage = new AgentStorage(storagePath, logger);
      const manager = new AgentManager({
        clients: { codex: new TestAgentClient() },
        registry: storage,
        logger,
        idFactory: () => "agent-non-worktree",
      });

      const agent = await manager.createAgent({
        provider: "codex",
        cwd: repoDir,
      });

      const server = await createAgentSelfIdMcpServer({
        agentManager: manager,
        callerAgentId: agent.id,
        logger,
      });
      const tool = (server as any)._registeredTools["set_branch"];

      await expect(tool.callback({ name: "should-fail" })).rejects.toMatchObject({
        code: "NOT_ALLOWED",
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("set_branch rejects non-git directories", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "paseo-self-ident-"));

    try {
      const storagePath = path.join(repoDir, "agents");
      const storage = new AgentStorage(storagePath, logger);
      const manager = new AgentManager({
        clients: { codex: new TestAgentClient() },
        registry: storage,
        logger,
        idFactory: () => "agent-non-git",
      });

      const agent = await manager.createAgent({
        provider: "codex",
        cwd: repoDir,
      });

      const server = await createAgentSelfIdMcpServer({
        agentManager: manager,
        callerAgentId: agent.id,
        logger,
      });
      const tool = (server as any)._registeredTools["set_branch"];

      await expect(tool.callback({ name: "nope" })).rejects.toMatchObject({
        code: "NOT_GIT_REPO",
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
