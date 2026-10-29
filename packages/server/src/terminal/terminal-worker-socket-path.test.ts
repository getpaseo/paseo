import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPlatform } from "../test-utils/platform.js";
import {
  resolveTerminalWorkerSocketPath,
  TerminalWorkerSocketPathError,
} from "./terminal-worker-socket-path.js";

const temporaryDirs: string[] = [];

function makeDir(prefix: string, root = tmpdir()): string {
  const dir = mkdtempSync(path.join(root, prefix));
  temporaryDirs.push(dir);
  return dir;
}

// A home path long enough that its socket cannot fit sun_path, with multi-byte segments so the
// budget is measured in bytes, not characters.
function longHome(root: string): string {
  const home = path.join(root, "worktree-ñandú-".repeat(5), "paseo-home");
  mkdirSync(home, { recursive: true });
  return home;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(isPlatform("win32"))("terminal worker socket path", () => {
  it("uses the home's own socket directory when the path fits", () => {
    // macOS $TMPDIR alone is ~50 bytes; a short root keeps the home's own path in budget.
    const home = makeDir("tw-h-", "/tmp");
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: home,
      workerPid: 4242,
      platform: "darwin",
    });
    expect(socketPath.startsWith(path.join(home, "terminal-worker", "sock"))).toBe(true);
  });

  it("falls to /tmp/paseo-<uid> when the home and TMPDIR are too long, within the byte budget", () => {
    const root = makeDir("tw-sock-long-");
    const home = longHome(root);
    const tmpDir = path.join(root, "tmp-ñandú-".repeat(6));
    mkdirSync(tmpDir, { recursive: true });
    const uid = process.getuid!();
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: home,
      workerPid: 99999,
      platform: "darwin",
      tmpDir,
    });
    expect(path.dirname(socketPath)).toBe(`/tmp/paseo-${uid}`);
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);
  });

  it("rejects a shared-root directory that is a symlink, has another mode, or is not a directory", () => {
    const root = makeDir("tw-sock-reject-");
    const home = longHome(root);
    const uid = process.getuid!();
    const tmpDir = makeDir("tw-");
    const target = makeDir("tw-target-");
    chmodSync(target, 0o700);
    symlinkSync(target, path.join(tmpDir, `paseo-${uid}`));
    // A budget check alone would accept the long-home fallback through the symlink; it must
    // also be refused, and /tmp/paseo-<uid> takes over.
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: home,
      workerPid: 7,
      platform: "darwin",
      tmpDir,
    });
    expect(path.dirname(socketPath)).toBe(`/tmp/paseo-${uid}`);

    const wideTmp = makeDir("tw-");
    mkdirSync(path.join(wideTmp, `paseo-${uid}`), { mode: 0o755 });
    chmodSync(path.join(wideTmp, `paseo-${uid}`), 0o755);
    expect(
      path.dirname(
        resolveTerminalWorkerSocketPath({
          paseoHome: home,
          workerPid: 7,
          platform: "darwin",
          tmpDir: wideTmp,
        }),
      ),
    ).toBe(`/tmp/paseo-${uid}`);
  });

  it("names every rejected candidate with its byte length when none fits", () => {
    const root = makeDir("tw-sock-none-");
    const home = longHome(root);
    const tmpDir = path.join(root, "tmp-ñandú-".repeat(6));
    mkdirSync(tmpDir, { recursive: true });
    let caught: unknown;
    try {
      resolveTerminalWorkerSocketPath({
        paseoHome: home,
        workerPid: 7,
        platform: "darwin",
        tmpDir,
        // Another uid's /tmp/paseo-<uid> directory does not exist or is not ours; with a uid
        // nobody owns, the /tmp candidate's directory is created by us but owned by our real
        // uid, so it is rejected for its owner.
        uid: 2_000_000_000,
      });
    } catch (error) {
      caught = error;
    }
    rmSync("/tmp/paseo-2000000000", { recursive: true, force: true });
    expect(caught).toBeInstanceOf(TerminalWorkerSocketPathError);
    const rejected = (caught as TerminalWorkerSocketPathError).rejected;
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toMatch(/longer than 103 bytes/);
    expect(rejected[0].byteLength).toBe(Buffer.byteLength(rejected[0].path, "utf8"));
    expect(rejected[2].reason).toMatch(/owned by uid/);
  });

  it("accepts a real listen on the chosen path", async () => {
    const home = makeDir("tw-l-", "/tmp");
    const socketPath = resolveTerminalWorkerSocketPath({ paseoHome: home, workerPid: 5 });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
