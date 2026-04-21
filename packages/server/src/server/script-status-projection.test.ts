import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ScriptRouteStore } from "./script-proxy.js";
import {
  buildWorkspaceScriptPayloads,
  createScriptStatusEmitter,
} from "./script-status-projection.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

function createWorkspaceRepo(options?: {
  branchName?: string;
  paseoConfig?: Record<string, unknown>;
}): { tempDir: string; repoDir: string; cleanup: () => void } {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "script-projection-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync(`git init -b ${options?.branchName ?? "main"}`, { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });

  return {
    tempDir,
    repoDir,
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function buildPayloads(input: {
  workspaceId: string;
  workspaceDirectory: string;
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null;
  gitMetadata?: { projectSlug: string; currentBranch: string | null };
  resolveHealth?: (hostname: string) => ScriptHealthState | null;
}) {
  return buildWorkspaceScriptPayloads(input);
}

describe("script-status-projection", () => {
  it("projects plain scripts and services differently", () => {
    const workspaceId = "workspace-plain-and-service";
    const workspace = createWorkspaceRepo({
      paseoConfig: {
        scripts: {
          typecheck: { command: "npm run typecheck" },
          web: { type: "service", command: "npm run web", port: 3000 },
        },
      },
    });
    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "typecheck",
      type: "script",
      lifecycle: "stopped",
      terminalId: "term-script",
      exitCode: 0,
    });

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
        }),
      ).toEqual([
        {
          scriptName: "typecheck",
          type: "script",
          hostname: "typecheck",
          port: null,
          proxyUrl: null,
          lifecycle: "stopped",
          health: null,
          exitCode: 0,
        },
        {
          scriptName: "web",
          type: "service",
          hostname: "web.repo.localhost",
          port: 3000,
          proxyUrl: "http://web.repo.localhost:6767",
          lifecycle: "stopped",
          health: null,
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("builds service hostnames from service-provided git metadata", () => {
    const workspaceId = "workspace-service-metadata";
    const workspace = createWorkspaceRepo({
      branchName: "local-branch-that-should-not-be-read",
      paseoConfig: {
        scripts: {
          web: { type: "service", command: "npm run web", port: 3000 },
        },
      },
    });
    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
          gitMetadata: {
            projectSlug: "service-provided",
            currentBranch: "feature/from-service",
          },
        }),
      ).toEqual([
        {
          scriptName: "web",
          type: "service",
          hostname: "web.feature-from-service.service-provided.localhost",
          port: 3000,
          proxyUrl: "http://web.feature-from-service.service-provided.localhost:6767",
          lifecycle: "stopped",
          health: null,
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("overlays runtime, route, and health state for running services", () => {
    const workspaceId = "workspace-running-service";
    const workspace = createWorkspaceRepo({
      branchName: "feature/card",
      paseoConfig: {
        scripts: {
          web: { type: "service", command: "npm run web" },
        },
      },
    });
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "web.feature-card.repo.localhost",
      port: 4321,
      workspaceId,
      projectSlug: "repo",
      scriptName: "web",
    });
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "web",
      type: "service",
      lifecycle: "running",
      terminalId: "term-web",
      exitCode: null,
    });

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
          resolveHealth: () => "healthy",
        }),
      ).toEqual([
        {
          scriptName: "web",
          type: "service",
          hostname: "web.feature-card.repo.localhost",
          port: 4321,
          proxyUrl: "http://web.feature-card.repo.localhost:6767",
          lifecycle: "running",
          health: "healthy",
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("maps internal pending health to null on the wire", () => {
    const workspaceId = "workspace-pending-health";
    const workspace = createWorkspaceRepo({
      paseoConfig: {
        scripts: {
          web: { type: "service", command: "npm run web" },
        },
      },
    });
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "web.repo.localhost",
      port: 4321,
      workspaceId,
      projectSlug: "repo",
      scriptName: "web",
    });
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "web",
      type: "service",
      lifecycle: "running",
      terminalId: "term-web",
      exitCode: null,
    });

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
          resolveHealth: () => "pending",
        }),
      ).toEqual([
        {
          scriptName: "web",
          type: "service",
          hostname: "web.repo.localhost",
          port: 4321,
          proxyUrl: "http://web.repo.localhost:6767",
          lifecycle: "running",
          health: null,
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("includes orphaned running runtime entries even after config removal", () => {
    const workspaceId = "workspace-orphaned-service";
    const workspace = createWorkspaceRepo();
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "docs.repo.localhost",
      port: 3002,
      workspaceId,
      projectSlug: "repo",
      scriptName: "docs",
    });
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "docs",
      type: "service",
      lifecycle: "running",
      terminalId: "term-docs",
      exitCode: null,
    });

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
        }),
      ).toEqual([
        {
          scriptName: "docs",
          type: "service",
          hostname: "docs.repo.localhost",
          port: 3002,
          proxyUrl: "http://docs.repo.localhost:6767",
          lifecycle: "running",
          health: null,
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("projects orphaned plain scripts as scripts instead of services", () => {
    const workspaceId = "workspace-orphaned-script";
    const workspace = createWorkspaceRepo();
    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "typecheck",
      type: "script",
      lifecycle: "running",
      terminalId: "term-typecheck",
      exitCode: null,
    });

    try {
      expect(
        buildPayloads({
          workspaceId,
          workspaceDirectory: workspace.repoDir,
          routeStore,
          runtimeStore,
          daemonPort: 6767,
        }),
      ).toEqual([
        {
          scriptName: "typecheck",
          type: "script",
          hostname: "typecheck",
          port: null,
          proxyUrl: null,
          lifecycle: "running",
          health: null,
          exitCode: null,
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  it("createScriptStatusEmitter overlays health onto the projected workspace script list", async () => {
    const workspaceId = "workspace-emitter";
    const workspace = createWorkspaceRepo({
      paseoConfig: {
        scripts: {
          api: { type: "service", command: "npm run api" },
          typecheck: { command: "npm run typecheck" },
        },
      },
    });
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "api.repo.localhost",
      port: 3001,
      workspaceId,
      projectSlug: "repo",
      scriptName: "api",
    });
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    runtimeStore.set({
      workspaceId,
      scriptName: "api",
      type: "service",
      lifecycle: "running",
      terminalId: "term-api",
      exitCode: null,
    });

    const session = { emit: vi.fn() };
    const emitUpdate = createScriptStatusEmitter({
      sessions: () => [session],
      routeStore,
      runtimeStore,
      daemonPort: 6767,
      resolveWorkspaceDirectory: async (workspaceId) =>
        workspaceId === "workspace-emitter" ? workspace.repoDir : null,
    });

    try {
      emitUpdate(workspaceId, [
        {
          scriptName: "api",
          hostname: "api.repo.localhost",
          port: 3001,
          health: "healthy",
        },
      ]);
      await Promise.resolve();

      expect(session.emit).toHaveBeenCalledWith({
        type: "script_status_update",
        payload: {
          workspaceId,
          scripts: [
            {
              scriptName: "api",
              type: "service",
              hostname: "api.repo.localhost",
              port: 3001,
              proxyUrl: "http://api.repo.localhost:6767",
              lifecycle: "running",
              health: "healthy",
              exitCode: null,
            },
            {
              scriptName: "typecheck",
              type: "script",
              hostname: "typecheck",
              port: null,
              proxyUrl: null,
              lifecycle: "stopped",
              health: null,
              exitCode: null,
            },
          ],
        },
      });
    } finally {
      workspace.cleanup();
    }
  });
});
