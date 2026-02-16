import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import {
  createAgentWorktree,
  runAsyncWorktreeBootstrap,
} from "./worktree-bootstrap.js";

describe("runAsyncWorktreeBootstrap", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  async function waitForPathExists(targetPath: string, timeoutMs = 10000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (existsSync(targetPath)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for path: ${targetPath}`);
  }

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-bootstrap-test-")));
    repoDir = join(tempDir, "repo");
    paseoHome = join(tempDir, "paseo-home");

    execSync(`mkdir -p ${repoDir}`);
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
    execSync("echo 'hello' > file.txt", { cwd: repoDir, stdio: "pipe" });
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("streams running setup updates live and persists only a final setup timeline row", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: ['echo "line-one"; echo "line-two" 1>&2', 'echo "line-three"'],
        },
      })
    );
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'add setup'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktree = await createAgentWorktree({
      cwd: repoDir,
      branchName: "feature-streaming-setup",
      baseBranch: "main",
      worktreeSlug: "feature-streaming-setup",
      paseoHome,
    });

    const persisted: AgentTimelineItem[] = [];
    const live: AgentTimelineItem[] = [];

    await runAsyncWorktreeBootstrap({
      agentId: "agent-test",
      worktree,
      terminalManager: null,
      appendTimelineItem: async (item) => {
        persisted.push(item);
        return true;
      },
      emitLiveTimelineItem: async (item: AgentTimelineItem) => {
        live.push(item);
        return true;
      },
    });

    const liveSetupItems = live.filter(
      (item) =>
        item.type === "tool_call" &&
        item.name === "paseo_worktree_setup" &&
        item.status === "running"
    );
    expect(liveSetupItems.length).toBeGreaterThan(0);

    const persistedSetupItems = persisted.filter(
      (item) => item.type === "tool_call" && item.name === "paseo_worktree_setup"
    );
    expect(persistedSetupItems).toHaveLength(1);
    expect(persistedSetupItems[0]?.type).toBe("tool_call");
    if (persistedSetupItems[0]?.type === "tool_call") {
      expect(persistedSetupItems[0].status).toBe("completed");
      expect(persistedSetupItems[0].detail.type).toBe("worktree_setup");

      if (persistedSetupItems[0].detail.type === "worktree_setup") {
        expect(persistedSetupItems[0].detail.log).toContain(
          "==> [1/2] Running: echo \"line-one\"; echo \"line-two\" 1>&2"
        );
        expect(persistedSetupItems[0].detail.log).toContain("line-one");
        expect(persistedSetupItems[0].detail.log).toContain("line-two");
        expect(persistedSetupItems[0].detail.log).toContain(
          "==> [2/2] Running: echo \"line-three\""
        );
        expect(persistedSetupItems[0].detail.log).toContain("line-three");
        expect(persistedSetupItems[0].detail.log).toMatch(/<== \[1\/2\] Exit 0 in \d+\.\d{2}s/);
        expect(persistedSetupItems[0].detail.log).toMatch(/<== \[2\/2\] Exit 0 in \d+\.\d{2}s/);

        expect(persistedSetupItems[0].detail.commands).toHaveLength(2);
        expect(persistedSetupItems[0].detail.commands[0]).toMatchObject({
          index: 1,
          command: 'echo "line-one"; echo "line-two" 1>&2',
          status: "completed",
          exitCode: 0,
        });
        expect(persistedSetupItems[0].detail.commands[1]).toMatchObject({
          index: 2,
          command: 'echo "line-three"',
          status: "completed",
          exitCode: 0,
        });
        expect(
          typeof persistedSetupItems[0].detail.commands[0]?.durationMs === "number"
        ).toBe(true);
        expect(
          typeof persistedSetupItems[0].detail.commands[1]?.durationMs === "number"
        ).toBe(true);
      }
    }

    const liveCallIds = new Set(
      liveSetupItems
        .filter((item): item is Extract<AgentTimelineItem, { type: "tool_call" }> => item.type === "tool_call")
        .map((item) => item.callId)
    );
    expect(liveCallIds.size).toBe(1);
    if (persistedSetupItems[0]?.type === "tool_call") {
      expect(liveCallIds.has(persistedSetupItems[0].callId)).toBe(true);
    }
  });

  it("does not fail setup when live timeline emission throws", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: ['echo "ok"'],
        },
      })
    );
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'add setup'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktree = await createAgentWorktree({
      cwd: repoDir,
      branchName: "feature-live-failure",
      baseBranch: "main",
      worktreeSlug: "feature-live-failure",
      paseoHome,
    });

    const persisted: AgentTimelineItem[] = [];
    await expect(
      runAsyncWorktreeBootstrap({
        agentId: "agent-live-failure",
        worktree,
        terminalManager: null,
        appendTimelineItem: async (item) => {
          persisted.push(item);
          return true;
        },
        emitLiveTimelineItem: async () => {
          throw new Error("live emit failed");
        },
      })
    ).resolves.toBeUndefined();

    const persistedSetupItems = persisted.filter(
      (item) => item.type === "tool_call" && item.name === "paseo_worktree_setup"
    );
    expect(persistedSetupItems).toHaveLength(1);
    if (persistedSetupItems[0]?.type === "tool_call") {
      expect(persistedSetupItems[0].status).toBe("completed");
    }
  });

  it("truncates each command output to 64kb in the middle", async () => {
    const largeOutputCommand =
      "node -e \"process.stdout.write('prefix-'); process.stdout.write('x'.repeat(70000)); process.stdout.write('-suffix')\"";
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: [largeOutputCommand],
        },
      })
    );
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'add large output setup'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktree = await createAgentWorktree({
      cwd: repoDir,
      branchName: "feature-large-output",
      baseBranch: "main",
      worktreeSlug: "feature-large-output",
      paseoHome,
    });

    const persisted: AgentTimelineItem[] = [];
    await runAsyncWorktreeBootstrap({
      agentId: "agent-large-output",
      worktree,
      terminalManager: null,
      appendTimelineItem: async (item) => {
        persisted.push(item);
        return true;
      },
      emitLiveTimelineItem: async () => true,
    });

    const persistedSetupItem = persisted.find(
      (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" && item.name === "paseo_worktree_setup"
    );
    expect(persistedSetupItem).toBeDefined();
    expect(persistedSetupItem?.detail.type).toBe("worktree_setup");
    if (!persistedSetupItem || persistedSetupItem.detail.type !== "worktree_setup") {
      throw new Error("Expected worktree_setup tool detail");
    }

    expect(persistedSetupItem.detail.truncated).toBe(true);
    expect(persistedSetupItem.detail.log).toContain("prefix-");
    expect(persistedSetupItem.detail.log).toContain("-suffix");
    expect(persistedSetupItem.detail.log).toContain("...<output truncated in the middle>...");
  });

  it("waits for terminal output before sending bootstrap commands", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          terminals: [
            {
              name: "Ready Terminal",
              command: "echo ready",
            },
          ],
        },
      })
    );
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'add terminal bootstrap config'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktree = await createAgentWorktree({
      cwd: repoDir,
      branchName: "feature-terminal-readiness",
      baseBranch: "main",
      worktreeSlug: "feature-terminal-readiness",
      paseoHome,
    });

    let readyAt = 0;
    let sendAt = 0;
    let outputListener: ((chunk: { data: string }) => void) | null = null;

    await runAsyncWorktreeBootstrap({
      agentId: "agent-terminal-readiness",
      worktree,
      terminalManager: {
        async getTerminals() {
          return [];
        },
        async createTerminal(options) {
          setTimeout(() => {
            readyAt = Date.now();
            outputListener?.({ data: "$ " });
          }, 25);
          return {
            id: "term-ready",
            name: options.name ?? "Terminal",
            cwd: options.cwd,
            send: () => {
              sendAt = Date.now();
            },
            subscribe: () => () => {},
            onExit: () => () => {},
            subscribeRaw: (listener) => {
              outputListener = (chunk) =>
                listener({
                  data: chunk.data,
                  startOffset: 0,
                  endOffset: chunk.data.length,
                  replay: false,
                });
              return {
                unsubscribe: () => {
                  outputListener = null;
                },
                replayedFrom: 0,
                currentOffset: 0,
                earliestAvailableOffset: 0,
                reset: false,
              };
            },
            getOutputOffset: () => 0,
            getState: () => ({
              rows: 0,
              cols: 0,
              grid: [],
              scrollback: [],
              cursor: { row: 0, col: 0 },
            }),
            kill: () => {},
          };
        },
        registerCwdEnv() {},
        getTerminal() {
          return undefined;
        },
        killTerminal() {},
        listDirectories() {
          return [];
        },
        killAll() {},
        subscribeTerminalsChanged() {
          return () => {};
        },
      },
      appendTimelineItem: async () => true,
      emitLiveTimelineItem: async () => true,
    });

    expect(readyAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThanOrEqual(readyAt);
  });

  it("shares the same worktree runtime port across setup and bootstrap terminals", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: ['echo "$PASEO_WORKTREE_PORT" > setup-port.txt'],
          terminals: [
            {
              name: "Port Terminal",
              command: "true",
            },
          ],
        },
      })
    );
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'add port setup and terminals'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktree = await createAgentWorktree({
      cwd: repoDir,
      branchName: "feature-shared-runtime-port",
      baseBranch: "main",
      worktreeSlug: "feature-shared-runtime-port",
      paseoHome,
    });

    const registeredEnvs: Array<{ cwd: string; env: Record<string, string> }> = [];
    const createTerminalEnvs: Record<string, string>[] = [];
    const persisted: AgentTimelineItem[] = [];
    await runAsyncWorktreeBootstrap({
      agentId: "agent-shared-runtime-port",
      worktree,
      terminalManager: {
        async getTerminals() {
          return [];
        },
        async createTerminal(options) {
          createTerminalEnvs.push(options.env ?? {});
          return {
            id: "term-1",
            name: options.name ?? "Terminal",
            cwd: options.cwd,
            send: () => {},
            subscribe: () => () => {},
            onExit: () => () => {},
            subscribeRaw: () => ({
              unsubscribe: () => {},
              replayedFrom: 0,
              currentOffset: 0,
              earliestAvailableOffset: 0,
              reset: false,
            }),
            getOutputOffset: () => 1,
            getState: () => ({
              rows: 0,
              cols: 0,
              grid: [],
              scrollback: [],
              cursor: { row: 0, col: 0 },
            }),
            kill: () => {},
          };
        },
        registerCwdEnv(options) {
          registeredEnvs.push({ cwd: options.cwd, env: options.env });
        },
        getTerminal() {
          return undefined;
        },
        killTerminal() {},
        listDirectories() {
          return [];
        },
        killAll() {},
        subscribeTerminalsChanged() {
          return () => {};
        },
      },
      appendTimelineItem: async (item) => {
        persisted.push(item);
        return true;
      },
      emitLiveTimelineItem: async () => true,
    });

    const setupPortPath = join(worktree.worktreePath, "setup-port.txt");
    await waitForPathExists(setupPortPath);

    const setupPort = readFileSync(setupPortPath, "utf8").trim();
    expect(setupPort.length).toBeGreaterThan(0);
    expect(registeredEnvs).toHaveLength(1);
    expect(registeredEnvs[0]?.cwd).toBe(worktree.worktreePath);
    expect(registeredEnvs[0]?.env.PASEO_WORKTREE_PORT).toBe(setupPort);
    expect(createTerminalEnvs.length).toBeGreaterThan(0);
    expect(createTerminalEnvs[0]?.PASEO_WORKTREE_PORT).toBe(setupPort);

    const terminalToolCall = persisted.find(
      (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" &&
        item.name === "paseo_worktree_terminals" &&
        item.status === "completed"
    );
    expect(terminalToolCall?.status).toBe("completed");
  });
});
