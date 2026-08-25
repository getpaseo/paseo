import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestPaseoDaemon, DaemonClient, type TestPaseoDaemon } from "./test-utils/index.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

let daemon: TestPaseoDaemon;
let client: DaemonClient;
let cwd: string;
const clientId = "inventory-reconnect-fixture";
const execFileAsync = promisify(execFile);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function registryTreeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relative = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const entryPath = path.join(directory, entry.name);
      const entryRelative = path.join(relative, entry.name);
      hash.update(`${entry.isDirectory() ? "d" : "f"}\u0000${entryRelative}\u0000`);
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelative);
      } else {
        hash.update(await readFile(entryPath));
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function inventoryViaCli(
  daemonPort: number,
): Promise<{ entries: Array<Record<string, unknown>> }> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/bin/paseo"),
      "inventory",
      "sessions",
      "--host",
      `127.0.0.1:${daemonPort}`,
      "--json",
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout) as { entries: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  daemon = await createTestPaseoDaemon();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "inventory-fixture" } });
  cwd = await mkdtemp(path.join(tmpdir(), "paseo-inventory-e2e-"));
});

afterEach(async () => {
  await client.close();
  await daemon.close();
  await rm(cwd, { recursive: true, force: true });
});

test("reconnects an isolated daemon inventory snapshot across 200 fixture records", async () => {
  for (let index = 0; index < 200; index += 1) {
    await client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
        title: `inventory-fixture-${index}`,
      },
    });
  }

  const first = await client.inventorySessions({ limit: 100 });
  expect(first).toMatchObject({
    schema_version: "paseo.inventory_sessions.v1",
    entries: expect.any(Array),
    has_more: true,
  });
  expect(first.entries).toHaveLength(100);
  expect(first.next_cursor).not.toBeNull();

  await client.close();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId,
  });
  await client.connect();

  const second = await client.inventorySessions({
    snapshot_id: first.snapshot_id,
    cursor: first.next_cursor!,
    limit: 100,
  });
  expect(second).toMatchObject({
    snapshot_id: first.snapshot_id,
    has_more: false,
    next_cursor: null,
  });
  expect(second.entries).toHaveLength(100);

  const identities = [...first.entries, ...second.entries].map((entry) => entry.native_id);
  expect(new Set(identities)).toHaveLength(200);
}, 60000);

test("reports a seeded persisted-only running status as non-live", async () => {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "paseo-inventory-persisted-"));
  const recordDir = path.join(homeRoot, ".paseo", "agents", "tmp-persisted-only");
  const recordPath = path.join(recordDir, "persisted-only.json");
  await mkdir(recordDir, { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      id: "persisted-only",
      provider: "codex",
      cwd: "/tmp/persisted-only",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      lastStatus: "running",
    }),
    "utf8",
  );

  const persistedDaemon = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot });
  const persistedClient = new DaemonClient({
    url: `ws://127.0.0.1:${persistedDaemon.port}/ws`,
    clientId: "persisted-only-fixture",
  });
  try {
    await persistedClient.connect();
    const page = await persistedClient.inventorySessions({ limit: 200 });
    expect(page.entries).toContainEqual(
      expect.objectContaining({
        native_id: "persisted-only",
        status_raw: "running",
        live: false,
      }),
    );
  } finally {
    await persistedClient.close();
    await persistedDaemon.close();
    await rm(homeRoot, { recursive: true, force: true });
  }
}, 30000);

test("CLI inventory sees post-start persisted state and fails closed for a post-start unknown entry", async () => {
  expect((await inventoryViaCli(daemon.port)).entries).toEqual([]);

  const registry = path.join(daemon.paseoHome, "agents");
  const lateDir = path.join(registry, "late-project");
  await mkdir(lateDir, { recursive: true });
  await writeFile(
    path.join(lateDir, "late-agent.json"),
    JSON.stringify({
      id: "late-agent",
      provider: "codex",
      cwd: "/tmp/late-agent",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      lastStatus: "idle",
    }),
    "utf8",
  );
  const beforeValidRead = await registryTreeHash(registry);
  const fresh = await inventoryViaCli(daemon.port);
  expect(fresh.entries).toContainEqual(
    expect.objectContaining({ native_id: "late-agent", live: false }),
  );
  expect(await registryTreeHash(registry)).toBe(beforeValidRead);

  const unknown = path.join(registry, "unexpected.unknown");
  await writeFile(unknown, "unexpected", "utf8");
  const beforeFailure = await registryTreeHash(registry);
  await expect(inventoryViaCli(daemon.port)).rejects.toThrow("inventory_malformed_state");
  expect(await registryTreeHash(registry)).toBe(beforeFailure);
}, 30000);

test("inventory never returns an impossible persisted/live union during cross-authority capture", async () => {
  const registry = path.join(daemon.paseoHome, "agents");
  await mkdir(registry, { recursive: true });

  const rootReaddirReached = deferred<void>();
  const allowFirstRootReaddir = deferred<void>();
  const originalReaddir = fs.readdir;
  let heldFirstRootReaddir = false;
  const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
    ...args: Parameters<typeof fs.readdir>
  ) => {
    const entries = await originalReaddir(...args);
    if (!heldFirstRootReaddir && args[0] === registry) {
      heldFirstRootReaddir = true;
      rootReaddirReached.resolve();
      await allowFirstRootReaddir.promise;
    }
    return entries;
  }) as typeof fs.readdir);

  try {
    const inventory = client.inventorySessions({ limit: 200 });
    await rootReaddirReached.promise;

    const persistedDir = path.join(registry, "race-project");
    await mkdir(persistedDir, { recursive: true });
    await writeFile(
      path.join(persistedDir, "persisted-race.json"),
      JSON.stringify({
        id: "persisted-race",
        provider: "codex",
        cwd: "/tmp/persisted-race",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        lastStatus: "idle",
      }),
      "utf8",
    );
    const live = await client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd, title: "live-race" },
    });

    allowFirstRootReaddir.resolve();
    const page = await inventory;
    const identities = page.entries.map((entry) => entry.native_id);
    expect(identities).toContain("persisted-race");
    expect(identities).toContain(live.id);
    expect(identities).not.toEqual([live.id]);
  } finally {
    allowFirstRootReaddir.resolve();
    readdirSpy.mockRestore();
  }
}, 30000);
