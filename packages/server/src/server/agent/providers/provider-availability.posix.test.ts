// POSIX-only: POSIX PATH executable probing fixtures
/* eslint-disable max-nested-callbacks */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { isPlatform } from "../../../test-utils/platform.js";
import {
  CodexAppServerAgentClient,
  findDefaultCodexBinary,
  type CodexBinaryDiscoveryEnvironment,
} from "./codex-app-server-agent.js";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";

const originalEnv = {
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

afterEach(() => {
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
});

function createCodexDiscoveryEnvironment(): CodexBinaryDiscoveryEnvironment {
  const root = makeTempDir("codex-app-discovery-");
  return {
    platform: "darwin",
    applicationDirs: [join(root, "Applications"), join(root, "home", "Applications")],
    // Use a real executable lookup in an isolated directory instead of the host PATH.
    findPathBinary: () => findExecutable(join(root, "bin", "codex")),
  };
}

function installBundledCodex(applicationDir: string, appName: string): string {
  const resources = join(applicationDir, appName, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  return writeProviderShim(resources, "codex");
}

describe.skipIf(isPlatform("win32"))("Codex macOS app discovery", () => {
  test.each([
    [0, "Codex.app"],
    [0, "ChatGPT.app"],
    [1, "Codex.app"],
    [1, "ChatGPT.app"],
  ] as const)("finds a runnable CLI in application directory %i / %s", async (index, appName) => {
    const environment = createCodexDiscoveryEnvironment();
    const binary = installBundledCodex(environment.applicationDirs[index]!, appName);

    await expect(findDefaultCodexBinary(environment)).resolves.toBe(binary);
  });

  test("prefers a PATH result over installed app bundles", async () => {
    const environment = createCodexDiscoveryEnvironment();
    installBundledCodex(environment.applicationDirs[0]!, "Codex.app");
    const binDir = join(dirname(environment.applicationDirs[0]!), "bin");
    mkdirSync(binDir);
    const binary = writeProviderShim(binDir, "codex");

    await expect(findDefaultCodexBinary(environment)).resolves.toBe(binary);
  });

  test("prefers system Codex when all app bundles are runnable", async () => {
    const environment = createCodexDiscoveryEnvironment();
    const binary = installBundledCodex(environment.applicationDirs[0]!, "Codex.app");
    installBundledCodex(environment.applicationDirs[0]!, "ChatGPT.app");
    installBundledCodex(environment.applicationDirs[1]!, "Codex.app");
    installBundledCodex(environment.applicationDirs[1]!, "ChatGPT.app");

    await expect(findDefaultCodexBinary(environment)).resolves.toBe(binary);
  });

  test("skips an installed bundle that is not executable", async () => {
    const environment = createCodexDiscoveryEnvironment();
    const unusable = installBundledCodex(environment.applicationDirs[0]!, "Codex.app");
    chmodSync(unusable, 0o644);
    const binary = installBundledCodex(environment.applicationDirs[0]!, "ChatGPT.app");

    await expect(findDefaultCodexBinary(environment)).resolves.toBe(binary);
  });

  test("returns unavailable when the only installed bundle cannot run", async () => {
    const environment = createCodexDiscoveryEnvironment();
    const binary = installBundledCodex(environment.applicationDirs[0]!, "Codex.app");
    chmodSync(binary, 0o644);

    await expect(findDefaultCodexBinary(environment)).resolves.toBeNull();
  });

  test("returns unavailable when no app bundles are installed", async () => {
    await expect(findDefaultCodexBinary(createCodexDiscoveryEnvironment())).resolves.toBeNull();
  });

  test("does not select an installed macOS bundle on Linux", async () => {
    const environment = createCodexDiscoveryEnvironment();
    installBundledCodex(environment.applicationDirs[0]!, "Codex.app");

    await expect(findDefaultCodexBinary({ ...environment, platform: "linux" })).resolves.toBeNull();
  });
});
