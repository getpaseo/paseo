import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test } from "vitest";

import { isPlatform } from "../test-utils/platform.js";
import { probeExecutable } from "./executable.js";

const timeoutMs = 1000;
const timeoutSlackMs = 500;
const tempDirs: string[] = [];

interface ProbeFixture {
  name: string;
  expected: boolean;
  create: (dir: string) => { executablePath: string; pidFile?: string };
}

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-probe-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string | Buffer): string {
  writeFileSync(filePath, content);
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function scriptPath(dir: string, name: string): string {
  return process.platform === "win32" ? path.join(dir, `${name}.cmd`) : path.join(dir, name);
}

function createHangingFixture(dir: string): string {
  if (process.platform === "win32") {
    return writeExecutable(
      scriptPath(dir, "hangs"),
      "@echo off\r\n:loop\r\ntimeout /T 5 /NOBREAK > NUL\r\ngoto loop\r\n",
    );
  }
  return writeExecutable(
    scriptPath(dir, "hangs"),
    `#!/bin/sh\ntrap '' TERM\necho $$ > "${path.join(dir, "hangs.pid")}"\nwhile :; do :; done\n`,
  );
}

function createNoVersionFixture(dir: string): string {
  if (process.platform === "win32") {
    return writeExecutable(scriptPath(dir, "no-version"), "@echo off\r\nexit /b 0\r\n");
  }
  return writeExecutable(scriptPath(dir, "no-version"), "#!/bin/sh\nexit 0\n");
}

function createNonZeroFixture(dir: string): string {
  if (process.platform === "win32") {
    return writeExecutable(
      scriptPath(dir, "non-zero"),
      "@echo off\r\necho oops 1>&2\r\nexit /b 1\r\n",
    );
  }
  return writeExecutable(scriptPath(dir, "non-zero"), "#!/bin/sh\necho oops 1>&2\nexit 1\n");
}

function createSlowSuccessFixture(dir: string): string {
  if (process.platform === "win32") {
    return writeExecutable(
      scriptPath(dir, "slow-success"),
      "@echo off\r\nping -n 1 127.0.0.1 > NUL\r\nexit /b 0\r\n",
    );
  }
  return writeExecutable(scriptPath(dir, "slow-success"), "#!/bin/sh\nsleep 0.05\nexit 0\n");
}

function createDirectoryFixture(dir: string): string {
  const directoryPath = path.join(dir, "candidate-directory");
  mkdirSync(directoryPath);
  return directoryPath;
}

function missingAbsolutePath(): string {
  return process.platform === "win32" ? "C:\\no\\such\\path.exe" : "/no/such/path";
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = performance.now() + timeoutSlackMs;
  while (!existsSync(filePath) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const fixtures: ProbeFixture[] = [
  {
    name: "hangs forever after starting",
    expected: true,
    create: (dir) => ({
      executablePath: createHangingFixture(dir),
      pidFile: process.platform === "win32" ? undefined : path.join(dir, "hangs.pid"),
    }),
  },
  {
    name: "does not know --version and exits zero",
    expected: true,
    create: (dir) => ({ executablePath: createNoVersionFixture(dir) }),
  },
  {
    name: "exits non-zero immediately",
    expected: true,
    create: (dir) => ({ executablePath: createNonZeroFixture(dir) }),
  },
  {
    name: "starts slowly and exits zero",
    expected: true,
    create: (dir) => ({ executablePath: createSlowSuccessFixture(dir) }),
  },
  {
    name: "points at a directory",
    expected: false,
    create: (dir) => ({ executablePath: createDirectoryFixture(dir) }),
  },
  {
    name: "does not exist at an absolute path",
    expected: false,
    create: () => ({ executablePath: missingAbsolutePath() }),
  },
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("probeExecutable", () => {
  // POSIX-only: positive fixtures rely on direct script probing; Windows command-script probing has separate coverage.
  test.skipIf(isPlatform("win32")).each(fixtures.filter((fixture) => fixture.expected))(
    "$name",
    async ({ create, expected }) => {
      const { executablePath, pidFile } = create(makeTempDir());
      const startedAt = performance.now();

      const result = await probeExecutable(executablePath, timeoutMs);

      expect(result).toBe(expected);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(timeoutMs + timeoutSlackMs);
      if (pidFile) {
        await waitForFile(pidFile);
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    },
  );

  test.each(fixtures.filter((fixture) => !fixture.expected))(
    "$name",
    async ({ create, expected }) => {
      const { executablePath, pidFile } = create(makeTempDir());
      const startedAt = performance.now();

      const result = await probeExecutable(executablePath, timeoutMs);

      expect(result).toBe(expected);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(timeoutMs + timeoutSlackMs);
      if (pidFile) {
        await waitForFile(pidFile);
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    },
  );
});
