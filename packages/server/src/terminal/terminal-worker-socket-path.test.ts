import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPlatform } from "../test-utils/platform.js";
import {
  listenOnTerminalWorkerSocket,
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

const openServers: Server[] = [];

function listenFor(socketPath: string): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      openServers.push(server);
      resolve(server);
    });
  });
}

// Stands in for a filesystem that passes the directory checks but refuses AF_UNIX bind, as AFS
// does with EPERM.
function refuseBindUnder(directory: string, code: string) {
  return (socketPath: string): Promise<Server> => {
    if (socketPath.startsWith(directory + path.sep)) {
      return Promise.reject(
        Object.assign(new Error(`listen ${code}: ${socketPath}`), { code, syscall: "listen" }),
      );
    }
    return listenFor(socketPath);
  };
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
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
      recordId: "test",
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
      recordId: "test",
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
      recordId: "test",
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
          recordId: "test",
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
        recordId: "test",
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
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: home,
      recordId: "test",
      workerPid: 5,
    });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe.skipIf(isPlatform("win32"))("terminal worker socket listen", () => {
  it("falls back to the next directory when the home's filesystem refuses the bind", async () => {
    const home = makeDir("tw-b-", "/tmp");
    const tmpDir = makeDir("tw-t-", "/tmp");
    const homeSocketDirectory = path.join(home, "terminal-worker", "sock");
    const { socketPath, listener } = await listenOnTerminalWorkerSocket({
      paseoHome: home,
      recordId: "test",
      workerPid: 11,
      tmpDir,
      listen: refuseBindUnder(homeSocketDirectory, "EPERM"),
    });
    expect(path.dirname(socketPath)).toBe(path.join(tmpDir, `paseo-${process.getuid!()}`));
    expect(listener.address()).toBe(socketPath);
  });

  it("throws a listen error that does not mean the filesystem refuses sockets", async () => {
    const home = makeDir("tw-u-", "/tmp");
    const homeSocketDirectory = path.join(home, "terminal-worker", "sock");
    await expect(
      listenOnTerminalWorkerSocket({
        paseoHome: home,
        recordId: "test",
        workerPid: 12,
        tmpDir: makeDir("tw-t-", "/tmp"),
        listen: refuseBindUnder(homeSocketDirectory, "EADDRINUSE"),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("names every candidate's bind error when no directory accepts a socket", async () => {
    const home = makeDir("tw-n-", "/tmp");
    const tmpDir = makeDir("tw-t-", "/tmp");
    let caught: unknown;
    try {
      await listenOnTerminalWorkerSocket({
        paseoHome: home,
        recordId: "test",
        workerPid: 13,
        tmpDir,
        listen: refuseBindUnder("", "EPERM"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TerminalWorkerSocketPathError);
    const rejected = (caught as TerminalWorkerSocketPathError).rejected;
    expect(rejected.slice(0, 2)).toEqual([
      expect.objectContaining({
        path: expect.stringContaining(path.join(home, "terminal-worker", "sock")),
        reason: "cannot bind a socket here (EPERM)",
      }),
      expect.objectContaining({
        path: expect.stringContaining(path.join(tmpDir, `paseo-${process.getuid!()}`)),
        reason: "cannot bind a socket here (EPERM)",
      }),
    ]);
  });
});

it("uses a separate socket for each record even when its pid is reused", () => {
  const paseoHome = makeDir("tw-id-");
  const first = resolveTerminalWorkerSocketPath({ paseoHome, workerPid: 42, recordId: "old" });
  const second = resolveTerminalWorkerSocketPath({ paseoHome, workerPid: 42, recordId: "new" });
  expect(first).not.toBe(second);
});
