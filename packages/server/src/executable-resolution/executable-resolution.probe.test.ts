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
import { probeExecutable } from "./executable-resolution.js";

const timeoutMs = 3000;
const timeoutSlackMs = 1000;
const fixtureReadyTimeoutMs = 10_000;
const tempDirs: string[] = [];
const spawnedProbePids = new Set<number>();

interface ProbeFixture {
  name: string;
  expected: boolean;
  create: (dir: string) => { executablePath: string };
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
    "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n",
  );
}

function createHangingDescendantFixture(dir: string): string {
  const descendantPidFile = path.join(dir, "descendant.pid");
  const descendant = `process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000);`;
  return writeExecutable(
    scriptPath(dir, "hangs-with-descendant"),
    `#!/bin/sh
trap '' TERM
${JSON.stringify(process.execPath)} -e '${descendant}' &
child=$!
echo "$child" > "${descendantPidFile}"
wait "$child"
`,
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
  const deadline = performance.now() + fixtureReadyTimeoutMs;
  while (!existsSync(filePath) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(filePath)) {
    throw new Error(`Timed out waiting for fixture file: ${filePath}`);
  }
}

function readFixturePid(pidFile: string): number {
  const rawPid = readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(rawPid)) {
    throw new Error(`Invalid PID fixture contents: ${JSON.stringify(rawPid)}`);
  }
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID fixture value: ${rawPid}`);
  }
  spawnedProbePids.add(pid);
  return pid;
}

const fixtures: ProbeFixture[] = [
  {
    name: "hangs forever after starting",
    expected: true,
    create: (dir) => ({
      executablePath: createHangingFixture(dir),
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
  for (const pid of spawnedProbePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  spawnedProbePids.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("probeExecutable", () => {
  // POSIX-only: positive fixtures rely on direct script probing; Windows command-script probing has separate coverage.
  test.skipIf(isPlatform("win32")).each(fixtures.filter((fixture) => fixture.expected))(
    "$name",
    async ({ create, expected }) => {
      const { executablePath } = create(makeTempDir());
      const startedAt = performance.now();

      const result = await probeExecutable(executablePath, timeoutMs);

      expect(result).toBe(expected);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(timeoutMs + timeoutSlackMs);
    },
  );

  test.each(fixtures.filter((fixture) => !fixture.expected))(
    "$name",
    async ({ create, expected }) => {
      const { executablePath } = create(makeTempDir());
      const startedAt = performance.now();

      const result = await probeExecutable(executablePath, timeoutMs);

      expect(result).toBe(expected);
      expect(performance.now() - startedAt).toBeLessThanOrEqual(timeoutMs + timeoutSlackMs);
    },
  );

  test.skipIf(isPlatform("win32"))(
    "aborts a ready hanging wrapper and its descendant",
    async () => {
      const dir = makeTempDir();
      const executablePath = createHangingDescendantFixture(dir);
      const pidFile = path.join(dir, "descendant.pid");
      const controller = new AbortController();
      const probe = probeExecutable(executablePath, {
        probeTimeoutMs: 30_000,
        signal: controller.signal,
      });

      try {
        await waitForFile(pidFile);
        const pid = readFixturePid(pidFile);
        controller.abort(new Error("Stop ready probe fixture"));

        await expect(probe).rejects.toThrow("Stop ready probe fixture");
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        spawnedProbePids.delete(pid);
      } finally {
        controller.abort(new Error("Clean up probe fixture"));
        await probe.catch(() => undefined);
      }
    },
  );
});
