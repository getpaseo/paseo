// POSIX-only: POSIX PATH executable probing fixtures
/* eslint-disable max-nested-callbacks */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { isPlatform } from "../../../test-utils/platform.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};

const tempDirs: string[] = [];
const spawnedProbePids = new Set<number>();

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

function writeProviderShim(dir: string, command: string): string {
  const filePath = process.platform === "win32" ? join(dir, `${command}.cmd`) : join(dir, command);
  const content =
    process.platform === "win32"
      ? `@echo off\r\necho ${command} 1.0\r\n`
      : `#!/bin/sh\necho ${command} 1.0\n`;
  writeFileSync(filePath, content);
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeHangingProviderShim(dir: string, command: string, pidFile: string): string {
  const filePath = join(dir, command);
  writeFileSync(
    filePath,
    `#!/bin/sh\necho $$ >> "${pidFile}"\ntrap '' TERM\nwhile :; do :; done\n`,
  );
  chmodSync(filePath, 0o755);
  return filePath;
}

function readProbePids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

async function expectProcessExited(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
}

afterEach(() => {
  for (const pid of spawnedProbePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  spawnedProbePids.clear();
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isPlatform("win32"))("provider-availability POSIX-only", () => {
  test("Codex reports available when the default command resolves from PATH", async () => {
    const binDir = makeTempDir("provider-availability-codex-");
    isolatePathTo(binDir);
    writeProviderShim(binDir, "codex");
    const client = new CodexAppServerAgentClient(createTestLogger());

    await expect(client.isAvailable()).resolves.toBe(true);
  });

  test("OpenCode reports available when the default command resolves from PATH", async () => {
    const binDir = makeTempDir("provider-availability-opencode-");
    isolatePathTo(binDir);
    writeProviderShim(binDir, "opencode");
    const client = new OpenCodeAgentClient(createTestLogger());

    await expect(client.isAvailable()).resolves.toBe(true);
  });

  test("Codex production availability aborts and drains repeated executable probes", async () => {
    const binDir = makeTempDir("provider-availability-codex-abort-");
    const pidFile = join(binDir, "codex-probes.pid");
    isolatePathTo(binDir);
    writeHangingProviderShim(binDir, "codex", pidFile);
    const client = new CodexAppServerAgentClient(createTestLogger());

    for (let index = 1; index <= 3; index += 1) {
      const controller = new AbortController();
      const probe = client.isAvailable({ signal: controller.signal });
      await vi.waitFor(() => expect(readProbePids(pidFile)).toHaveLength(index));
      const pid = readProbePids(pidFile)[index - 1];
      spawnedProbePids.add(pid);

      controller.abort(new Error(`stop executable probe ${index}`));
      await expect(probe).rejects.toThrow(`stop executable probe ${index}`);
      await expectProcessExited(pid);
      spawnedProbePids.delete(pid);
    }
  });
});
