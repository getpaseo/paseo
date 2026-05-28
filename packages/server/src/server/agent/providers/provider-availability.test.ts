import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentProvider } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";

import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient, findDefaultCodexBinary } from "./codex-app-server-agent.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";

const originalEnv = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolatePathTo(dir: string): void {
  process.env.PATH = dir;
  if (process.platform === "win32") {
    process.env.PATHEXT = ".CMD";
  }
}

function isolateCodexDefaultDiscoveryTo(dir: string): void {
  isolatePathTo(dir);
  if (process.platform === "win32") {
    process.env.LOCALAPPDATA = dir;
  }
}

afterEach(() => {
  if (originalEnv.LOCALAPPDATA === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
  }
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("default provider availability", () => {
  test("Codex reports unavailable when the default command cannot be resolved", async () => {
    const binDir = makeTempDir("provider-availability-codex-");
    isolateCodexDefaultDiscoveryTo(binDir);
    const client = new CodexAppServerAgentClient(createTestLogger());

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("Codex reports available from a Microsoft Store install path when PATH misses codex", async () => {
    const originalPlatform = process.platform;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const root = makeTempDir("provider-availability-codex-store-");
    const emptyPathDir = join(root, "empty-path");
    const codexBinDir = join(
      root,
      "Packages",
      "OpenAI.Codex_abc123",
      "LocalCache",
      "Local",
      "OpenAI",
      "Codex",
      "bin",
    );
    const codexExe = join(codexBinDir, "codex.exe");
    mkdirSync(emptyPathDir, { recursive: true });
    mkdirSync(codexBinDir, { recursive: true });
    copyFileSync(process.execPath, codexExe);
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.env.LOCALAPPDATA = root;
    isolatePathTo(emptyPathDir);
    process.env.PATHEXT = ".EXE";

    try {
      const client = new CodexAppServerAgentClient(createTestLogger());

      await expect(findDefaultCodexBinary()).resolves.toBe(codexExe);
      await expect(client.isAvailable()).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  test("Claude reports unavailable when the default command cannot be resolved", async () => {
    const binDir = makeTempDir("provider-availability-claude-");
    isolatePathTo(binDir);
    const client = new ClaudeAgentClient({ logger: createTestLogger() });

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("OpenCode reports unavailable when the default command cannot be resolved", async () => {
    const binDir = makeTempDir("provider-availability-opencode-");
    isolatePathTo(binDir);
    const client = new OpenCodeAgentClient(createTestLogger());

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("AgentManager reports Codex unavailable without throwing", async () => {
    const binDir = makeTempDir("provider-availability-manager-bin-");
    isolateCodexDefaultDiscoveryTo(binDir);
    const workdir = makeTempDir("provider-availability-manager-work-");
    const storage = new AgentStorage(join(workdir, "agents"), createTestLogger());
    const manager = new AgentManager({
      clients: {
        codex: new CodexAppServerAgentClient(createTestLogger()),
      },
      registry: storage,
      logger: createTestLogger(),
    });

    await expect(manager.listProviderAvailability()).resolves.toEqual([
      {
        provider: "codex",
        available: false,
        error: null,
      },
    ]);
  });

  test("resumeAgentFromPersistence stops before provider spawn when Codex is unavailable", async () => {
    const binDir = makeTempDir("provider-availability-resume-bin-");
    isolateCodexDefaultDiscoveryTo(binDir);
    const workdir = makeTempDir("provider-availability-resume-work-");
    const storage = new AgentStorage(join(workdir, "agents"), createTestLogger());
    const manager = new AgentManager({
      clients: {
        codex: new CodexAppServerAgentClient(createTestLogger()),
      },
      registry: storage,
      logger: createTestLogger(),
    });

    await expect(
      manager.resumeAgentFromPersistence(
        {
          provider: "codex" as AgentProvider,
          sessionId: "missing-codex-session",
          metadata: {
            provider: "codex",
            cwd: workdir,
          },
        },
        { cwd: workdir },
      ),
    ).rejects.toThrow("Provider 'codex' is not available");
  });
});
