import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectHostAutomation, connectToDaemon } from "@getpaseo/client/node";
import { afterEach, expect, test } from "vitest";
import { hashDaemonPassword } from "../auth.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupConnections = new Set<{ close(): Promise<void> }>();

afterEach(async () => {
  await Promise.all([...cleanupConnections].map((connection) => connection.close()));
  cleanupConnections.clear();
  await Promise.all([...cleanupDaemons].map((daemon) => daemon.close()));
  cleanupDaemons.clear();
  for (const target of cleanupPaths) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Windows can retain a temporary repository handle past daemon shutdown.
      // The runner discards its temp root; every other cleanup failure remains fatal.
      if (!isWindowsBusyError(error)) throw error;
    }
  }
  cleanupPaths.clear();
});

function isWindowsBusyError(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    error instanceof Error &&
    "code" in error &&
    error.code === "EBUSY"
  );
}

test("a different live checkout continues to protect its branch", async () => {
  const repoRoot = createRepository();
  const existingPath = path.join(path.dirname(repoRoot), "existing-feature");
  execFileSync("git", ["worktree", "add", existingPath, "feature"], { cwd: repoRoot });
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const paseo = await connectHostAutomation({
    appVersion: "0.1.110",
    clientId: "import-live-protection-e2e",
    env: {},
    host: `127.0.0.1:${daemon.port}`,
  });
  cleanupConnections.add(paseo);

  await expect(
    paseo.ensureCheckout({
      rootPath: repoRoot,
      refName: "feature",
      directoryName: "different-feature",
    }),
  ).rejects.toThrow(/already checked out|in use/i);
  expect(realpathSync(existingPath)).toBe(existingPath);
});

test("ensureCheckout repairs only the requested missing registration", async () => {
  const repoRoot = createRepository();
  execFileSync("git", ["branch", "unrelated"], { cwd: repoRoot });
  const staleFeature = path.join(path.dirname(repoRoot), "stale-feature");
  const staleUnrelated = path.join(path.dirname(repoRoot), "stale-unrelated");
  execFileSync("git", ["worktree", "add", staleFeature, "feature"], { cwd: repoRoot });
  execFileSync("git", ["worktree", "add", staleUnrelated, "unrelated"], { cwd: repoRoot });
  rmSync(staleFeature, { recursive: true, force: true });
  rmSync(staleUnrelated, { recursive: true, force: true });

  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const paseo = await connectHostAutomation({
    appVersion: "0.1.110",
    clientId: "import-stale-registration-e2e",
    env: {},
    host: `127.0.0.1:${daemon.port}`,
  });
  cleanupConnections.add(paseo);

  const ensured = await paseo.ensureCheckout({
    rootPath: repoRoot,
    refName: "feature",
    directoryName: "imported-feature",
  });

  expect(path.basename(ensured.path)).toBe("imported-feature");
  const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(registrations).toContain("branch refs/heads/feature");
  expect(registrations).toContain("branch refs/heads/unrelated");
});

test("normalized checkout-name collisions cannot reuse another branch", async () => {
  const repoRoot = createRepository();
  execFileSync("git", ["branch", "other-feature"], { cwd: repoRoot });
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const paseo = await connectHostAutomation({
    appVersion: "0.1.110",
    clientId: "import-slug-collision-e2e",
    env: {},
    host: `127.0.0.1:${daemon.port}`,
  });
  cleanupConnections.add(paseo);
  await paseo.addProject(repoRoot);

  const first = await paseo.ensureCheckout({
    rootPath: repoRoot,
    refName: "feature",
    directoryName: "Foo.Bar",
  });
  const same = await paseo.ensureCheckout({
    rootPath: repoRoot,
    refName: "refs/heads/feature",
    directoryName: "foo-bar",
  });
  const firstStats = statSync(first.path);
  expect(statSync(same.path)).toMatchObject({ dev: firstStats.dev, ino: firstStats.ino });
  await expect(
    paseo.ensureCheckout({
      rootPath: repoRoot,
      refName: "other-feature",
      directoryName: "foo-bar",
    }),
  ).rejects.toThrow(/already used by branch feature/);

  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: first.path,
      encoding: "utf8",
    }).trim(),
  ).toBe("feature");
});

test("the public connector authenticates to a real password-protected daemon and closes cleanly", async () => {
  const daemon = await createTestPaseoDaemon({
    auth: { password: hashDaemonPassword("connector-secret") },
  });
  cleanupDaemons.add(daemon);

  await expect(
    connectToDaemon({
      appVersion: "0.1.110",
      clientId: "import-auth-failure-e2e",
      env: { PASEO_PASSWORD: "wrong-secret" },
      host: `127.0.0.1:${daemon.port}`,
      timeoutMs: 2_000,
    }),
  ).rejects.toThrow(/auth|password|unauthorized/i);

  const client = await connectToDaemon({
    appVersion: "0.1.110",
    clientId: "import-auth-success-e2e",
    env: { PASEO_PASSWORD: "connector-secret" },
    host: `127.0.0.1:${daemon.port}`,
  });
  const beforeClose = await client.fetchAgents();
  await client.close();

  expect(beforeClose.entries).toEqual([]);
  await expect(client.fetchAgents()).rejects.toThrow();
});

test("the public connector uses PORT fallback and skips malformed discovered candidates", async () => {
  const daemon = await createTestPaseoDaemon();
  cleanupDaemons.add(daemon);
  const paseoHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-connector-home-")));
  cleanupPaths.add(paseoHome);
  writeFileSync(path.join(paseoHome, "paseo.pid"), '{"listen":"tcp://missing-port"}');

  const client = await connectToDaemon({
    appVersion: "0.1.110",
    clientId: "import-port-fallback-e2e",
    env: { PASEO_HOME: paseoHome, PORT: String(daemon.port) },
  });
  cleanupConnections.add(client);

  expect((await client.fetchAgents()).entries).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "the public connector reaches a real daemon through its Unix socket",
  async () => {
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-connector-ipc-")));
    cleanupPaths.add(parent);
    const socketPath = path.join(parent, "paseo.sock");
    const daemon = await createTestPaseoDaemon({ listen: socketPath, allowIpc: true });
    cleanupDaemons.add(daemon);
    expect(daemon.listenTarget).toEqual({ type: "socket", path: socketPath });
    expect(existsSync(socketPath)).toBe(true);

    const client = await connectToDaemon({
      appVersion: "0.1.110",
      clientId: "import-ipc-e2e",
      env: {},
      host: `unix://${socketPath}`,
    });
    cleanupConnections.add(client);

    expect((await client.fetchAgents()).entries).toEqual([]);
  },
);

function createRepository(): string {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-import-daemon-")));
  cleanupPaths.add(parent);
  const repoRoot = path.join(parent, "repo");
  execFileSync("git", ["init", "-b", "main", repoRoot]);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], {
    cwd: repoRoot,
  });
  execFileSync("git", ["branch", "feature"], { cwd: repoRoot });
  return realpathSync(repoRoot);
}
