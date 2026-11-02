// POSIX-only: worktree setup shell and terminal service fixtures
/* eslint-disable max-nested-callbacks */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import { ScriptRouteStore } from "./script-proxy.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { isPlatform } from "../test-utils/platform.js";
import { createTerminalManager, type TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";

async function cleanupTerminalManager(terminalManager: TerminalManager): Promise<void> {
  const terminalsByCwd = await Promise.all(
    terminalManager.listDirectories().map((cwd) => terminalManager.getTerminals(cwd)),
  );
  const terminals = terminalsByCwd.flat();
  await Promise.all(terminals.map((terminal) => killTerminal(terminalManager, terminal)));
  terminalManager.killAll();
}

function killTerminal(terminalManager: TerminalManager, terminal: TerminalSession): Promise<void> {
  return terminalManager.killTerminalAndWait(terminal.id, {
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 100,
  });
}

describe.skipIf(isPlatform("win32"))("worktree-bootstrap POSIX-only", () => {
  describe("workspace scripts", () => {
    let tempDir: string;
    let repoDir: string;
    let realTerminalManagers: TerminalManager[];

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

    function readEnvFile(path: string): Record<string, string> {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected env file to contain a JSON object: ${path}`);
      }

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          env[key] = value;
        }
      }
      return env;
    }

    beforeEach(() => {
      realTerminalManagers = [];
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-bootstrap-test-")));
      repoDir = join(tempDir, "repo");

      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
        stdio: "pipe",
      });
    });

    afterEach(async () => {
      await Promise.all(realTerminalManagers.map(cleanupTerminalManager));
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("injects real peer service env into terminal-backed services", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          scripts: {
            api: {
              type: "service",
              command:
                "node -e \"const fs=require('fs'); fs.writeFileSync('api-env.json.tmp', JSON.stringify(process.env)); fs.renameSync('api-env.json.tmp', 'api-env.json'); setTimeout(()=>{}, 30000)\"",
            },
            web: {
              type: "service",
              command:
                "node -e \"const fs=require('fs'); fs.writeFileSync('web-env.json.tmp', JSON.stringify(process.env)); fs.renameSync('web-env.json.tmp', 'web-env.json'); setTimeout(()=>{}, 30000)\"",
            },
          },
        }),
      );
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add real peer env services"],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      );

      const routeStore = new ScriptRouteStore();
      const runtimeStore = new WorkspaceScriptRuntimeStore();
      const terminalManager = createTerminalManager();
      realTerminalManagers.push(terminalManager);

      await Promise.all(
        ["api", "web"].map((scriptName) =>
          spawnWorkspaceScript({
            repoRoot: repoDir,
            workspaceId: repoDir,
            projectSlug: "repo",
            branchName: "feature-peer-env",
            scriptName,
            daemonPort: 6767,
            serviceProxy: routeStore,
            runtimeStore,
            terminalManager,
          }),
        ),
      );

      const apiEnvPath = join(repoDir, "api-env.json");
      const webEnvPath = join(repoDir, "web-env.json");
      await waitForPathExists(apiEnvPath);
      await waitForPathExists(webEnvPath);

      const apiEnv = readEnvFile(apiEnvPath);
      const webEnv = readEnvFile(webEnvPath);

      expect(apiEnv.PASEO_SERVICE_API_URL).toBe(
        "http://api--feature-peer-env--repo.localhost:6767",
      );
      expect(apiEnv.PASEO_SERVICE_WEB_URL).toBe(
        "http://web--feature-peer-env--repo.localhost:6767",
      );
      expect(apiEnv.PASEO_SERVICE_API_PORT).toEqual(expect.stringMatching(/^\d+$/));
      expect(apiEnv.PASEO_SERVICE_WEB_PORT).toEqual(expect.stringMatching(/^\d+$/));
      expect(apiEnv.PASEO_URL).toBe(apiEnv.PASEO_SERVICE_API_URL);
      expect(apiEnv.PASEO_PORT).toBe(apiEnv.PASEO_SERVICE_API_PORT);
      expect(apiEnv).not.toHaveProperty("PORT");

      expect(webEnv.PASEO_SERVICE_API_URL).toBe(
        "http://api--feature-peer-env--repo.localhost:6767",
      );
      expect(webEnv.PASEO_SERVICE_WEB_URL).toBe(
        "http://web--feature-peer-env--repo.localhost:6767",
      );
      expect(webEnv.PASEO_SERVICE_API_PORT).toBe(apiEnv.PASEO_SERVICE_API_PORT);
      expect(webEnv.PASEO_SERVICE_WEB_PORT).toBe(apiEnv.PASEO_SERVICE_WEB_PORT);
      expect(webEnv.PASEO_URL).toBe(webEnv.PASEO_SERVICE_WEB_URL);
      expect(webEnv.PASEO_PORT).toBe(webEnv.PASEO_SERVICE_WEB_PORT);
      expect(webEnv).not.toHaveProperty("PORT");

      const apiPort = Number(apiEnv.PASEO_SERVICE_API_PORT);
      const webPort = Number(apiEnv.PASEO_SERVICE_WEB_PORT);
      expect(Number.isInteger(apiPort)).toBe(true);
      expect(Number.isInteger(webPort)).toBe(true);
      expect(routeStore.listRoutes()).toEqual([
        {
          hostname: "api--feature-peer-env--repo.localhost",
          port: apiPort,
          workspaceId: repoDir,
          projectSlug: "repo",
          scriptName: "api",
        },
        {
          hostname: "web--feature-peer-env--repo.localhost",
          port: webPort,
          workspaceId: repoDir,
          projectSlug: "repo",
          scriptName: "web",
        },
      ]);
    });
  });
});
