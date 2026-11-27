import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { GenericACPAgentClient } from "./providers/generic-acp-agent.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFakeAcpExecutable(options: {
  dir: string;
  name: string;
  logFile: string;
  models: Array<{ value: string; name: string }>;
  version?: string;
}): Promise<string> {
  const filePath = path.join(options.dir, options.name);
  const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const args = process.argv.slice(2);
appendFileSync(
  ${JSON.stringify(options.logFile)},
  JSON.stringify({ kind: "spawn", args, cwd: process.cwd() }) + "\\n",
);

if (args.includes("--version")) {
  console.log(${JSON.stringify(options.version ?? "1.5.18")});
  process.exit(0);
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: ${JSON.stringify(options.models[0]?.value ?? "default-model")},
    options: ${JSON.stringify(options.models)},
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendFileSync(
    ${JSON.stringify(options.logFile)},
    JSON.stringify({ kind: "rpc", method: msg.method, params: msg.params }) + "\\n",
  );
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ id: msg.id, result: { sessionId: "sess-1", configOptions } });
  } else if (msg.method === "session/close") {
    send({ id: msg.id, result: {} });
  }
});
`;
  if (process.platform === "win32") {
    const scriptPath = path.join(options.dir, `${options.name}.cjs`);
    await writeFile(scriptPath, script, "utf8");
    const cmdPath = path.join(options.dir, `${options.name}.cmd`);
    await writeFile(
      cmdPath,
      [
        "@echo off",
        `:: models=${options.models.map((m) => m.value).join(",")}`,
        `"${process.execPath}" "${scriptPath}" %*`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    return cmdPath;
  }

  await writeFile(filePath, script, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

async function readEvents(logFile: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(logFile, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function acpSpawns(events: Array<Record<string, unknown>>) {
  return events.filter(
    (event) => event.kind === "spawn" && Array.isArray(event.args) && event.args.includes("acp"),
  );
}

function disabledBuiltinsOverrides() {
  return Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }]));
}

describe("respectful ACP probing", () => {
  test("plugin ACP on_demand coalesces across 3 workspaces (1 spawn), hydrates from disk on restart (0 spawns), and re-discovers when binary changes", async () => {
    const dir = await createTempDir("paseo-acp-ondemand-");
    const logFile = path.join(dir, "trace.ndjson");
    const cachePath = path.join(dir, "cache", "provider-catalogs.json");
    const binary = await createFakeAcpExecutable({
      dir,
      name: "fake-acp",
      logFile,
      models: [{ value: "model-v1", name: "Model V1" }],
    });

    const registration = runAcpProvider({
      id: "fake-acp",
      label: "Fake ACP",
      command: [binary, "acp"],
    });
    expect(registration.catalogRefresh).toBe("on_demand");

    const manager1 = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: disabledBuiltinsOverrides(),
      catalogCachePath: cachePath,
    });
    try {
      manager1.replacePluginProviders([registration]);
      await Promise.all([
        manager1.getProvider({ provider: "fake-acp", wait: true }),
        manager1.getProvider({ provider: "fake-acp", cwd: path.join(dir, "ws-1"), wait: true }),
        manager1.getProvider({ provider: "fake-acp", cwd: path.join(dir, "ws-2"), wait: true }),
        manager1.getProvider({ provider: "fake-acp", cwd: path.join(dir, "ws-3"), wait: true }),
      ]);

      const entry1 = await manager1.getProvider({ provider: "fake-acp", wait: false });
      expect(entry1).toMatchObject({
        status: "ready",
        models: [expect.objectContaining({ id: "model-v1", label: "Model V1" })],
      });

      const eventsAfterColdStart = await readEvents(logFile);
      expect(acpSpawns(eventsAfterColdStart)).toHaveLength(1);

      const initializeCall = eventsAfterColdStart.find(
        (event) => event.kind === "rpc" && event.method === "initialize",
      );
      expect(initializeCall?.params).toMatchObject({
        clientInfo: {
          name: "paseo",
          title: "Paseo",
          version: resolveDaemonVersion(import.meta.url),
        },
      });
    } finally {
      await manager1.shutdown();
    }

    // Restart with unchanged binary -> 0 spawns, hydrates from disk cache.
    const manager2 = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: disabledBuiltinsOverrides(),
      catalogCachePath: cachePath,
    });
    try {
      manager2.replacePluginProviders([registration]);
      const entry2 = await manager2.getProvider({ provider: "fake-acp", wait: true });
      expect(entry2).toMatchObject({
        status: "ready",
        models: [expect.objectContaining({ id: "model-v1", label: "Model V1" })],
      });
      expect(acpSpawns(await readEvents(logFile))).toHaveLength(1);
    } finally {
      await manager2.shutdown();
    }

    // Upgrade binary on disk (different size + mtime) -> re-discovers once on next start.
    await createFakeAcpExecutable({
      dir,
      name: "fake-acp",
      logFile,
      models: [
        { value: "model-v1", name: "Model V1" },
        { value: "model-v2", name: "Model V2 Upgraded" },
      ],
    });
    const manager3 = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: disabledBuiltinsOverrides(),
      catalogCachePath: cachePath,
    });
    try {
      manager3.replacePluginProviders([registration]);
      const entry3 = await manager3.getProvider({ provider: "fake-acp", wait: true });
      expect(entry3.models?.map((model) => model.id)).toEqual(["model-v1", "model-v2"]);
      expect(acpSpawns(await readEvents(logFile))).toHaveLength(2);

      // Explicit manual Refresh runs 1 global spawn and updates the cache.
      await manager3.refreshSettingsSnapshot({ providers: ["fake-acp"] });
      expect(acpSpawns(await readEvents(logFile))).toHaveLength(3);
    } finally {
      await manager3.shutdown();
    }
  });

  test("installed binary failing status() surfaces actionable error instead of Not installed, with 0 ACP spawns", async () => {
    const dir = await createTempDir("paseo-acp-status-err-");
    const logFile = path.join(dir, "trace.ndjson");
    const cachePath = path.join(dir, "cache", "provider-catalogs.json");
    const binary = await createFakeAcpExecutable({
      dir,
      name: "old-cli",
      logFile,
      models: [{ value: "m1", name: "M1" }],
    });

    const registration: ProviderRegistration = {
      ...runAcpProvider({
        id: "old-cli",
        label: "Old CLI",
        command: [binary, "acp"],
      }),
      async status() {
        return {
          available: false,
          diagnostic:
            "Antigravity CLI 1.5.0 is older than 1.5.1. Update Antigravity CLI to 1.5.1 or later.\nSSH session: no",
        };
      },
    };

    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: disabledBuiltinsOverrides(),
      catalogCachePath: cachePath,
    });
    try {
      manager.replacePluginProviders([registration]);
      const entry = await manager.getProvider({ provider: "old-cli", wait: true });
      expect(entry).toMatchObject({
        status: "error",
        error:
          "Antigravity CLI 1.5.0 is older than 1.5.1. Update Antigravity CLI to 1.5.1 or later.",
      });
      expect((await readEvents(logFile)).filter((event) => event.kind === "spawn")).toHaveLength(0);
    } finally {
      await manager.shutdown();
    }
  });

  test("core server GenericACPAgentClient defaults to on_demand, global cache key, and real clientInfo", async () => {
    const dir = await createTempDir("paseo-core-acp-");
    const logFile = path.join(dir, "trace.ndjson");
    const cachePath = path.join(dir, "cache", "provider-catalogs.json");
    const binary = await createFakeAcpExecutable({
      dir,
      name: "core-acp",
      logFile,
      models: [{ value: "core-model", name: "Core Model" }],
    });

    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: [binary, "acp"],
      providerId: "core-acp",
      label: "Core ACP",
    });
    expect(client.catalogRefresh).toBe("on_demand");
    const keyGlobal = await client.getCatalogCacheKey({ scope: "global", force: false });
    const keyWs1 = await client.getCatalogCacheKey({
      scope: "workspace",
      cwd: path.join(dir, "ws-1"),
      force: false,
    });
    const keyWs2 = await client.getCatalogCacheKey({
      scope: "workspace",
      cwd: path.join(dir, "ws-2"),
      force: false,
    });
    expect(keyGlobal).toBeTruthy();
    expect(keyWs1).toBe(keyGlobal);
    expect(keyWs2).toBe(keyGlobal);

    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        ...disabledBuiltinsOverrides(),
        "core-acp": {
          extends: "acp",
          label: "Core ACP",
          command: [binary, "acp"],
        },
      },
      catalogCachePath: cachePath,
    });
    try {
      await Promise.all([
        manager.getProvider({ provider: "core-acp", wait: true }),
        manager.getProvider({ provider: "core-acp", cwd: path.join(dir, "ws-1"), wait: true }),
        manager.getProvider({ provider: "core-acp", cwd: path.join(dir, "ws-2"), wait: true }),
      ]);
      const entry = await manager.getProvider({ provider: "core-acp", wait: false });
      expect(entry).toMatchObject({
        status: "ready",
        models: [expect.objectContaining({ id: "core-model" })],
      });
      const events = await readEvents(logFile);
      expect(acpSpawns(events)).toHaveLength(1);
      const init = events.find((event) => event.kind === "rpc" && event.method === "initialize");
      expect(init?.params).toMatchObject({
        clientInfo: {
          name: "paseo",
          title: "Paseo",
          version: resolveDaemonVersion(import.meta.url),
        },
      });
    } finally {
      await manager.shutdown();
    }
  });

  test("workspaceOnlyCatalog (hoplite-style) skips global session/new and discovers per workspace on demand", async () => {
    const dir = await createTempDir("paseo-acp-hoplite-");
    const logFile = path.join(dir, "trace.ndjson");
    const cachePath = path.join(dir, "cache", "provider-catalogs.json");
    const binary = await createFakeAcpExecutable({
      dir,
      name: "hoplite-acp",
      logFile,
      models: [{ value: "ws-model", name: "Workspace Model" }],
    });

    const registration = runAcpProvider({
      id: "hoplite-test",
      label: "Hoplite Test",
      command: [binary, "acp"],
      acpOptions: { workspaceOnlyCatalog: true },
    });
    expect(registration.catalogRefresh).toBe("on_demand");
    expect(registration.getCatalogCacheKey).toBeUndefined();

    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: disabledBuiltinsOverrides(),
      catalogCachePath: cachePath,
    });
    try {
      manager.replacePluginProviders([registration]);
      const globalEntry = await manager.getProvider({ provider: "hoplite-test", wait: true });
      expect(globalEntry).toMatchObject({ status: "ready", models: [], modes: [] });
      const eventsAfterGlobal = await readEvents(logFile);
      expect(
        eventsAfterGlobal.filter((event) => event.kind === "rpc" && event.method === "session/new"),
      ).toHaveLength(0);

      // Workspace target discovers models for that workspace.
      const ws1 = path.join(dir, "ws-1");
      await mkdir(ws1, { recursive: true });
      const wsEntry = await manager.getProvider({
        provider: "hoplite-test",
        cwd: ws1,
        wait: true,
      });
      expect(wsEntry).toMatchObject({
        status: "ready",
        models: [expect.objectContaining({ id: "ws-model" })],
      });
      const eventsAfterWs = await readEvents(logFile);
      expect(
        eventsAfterWs.filter((event) => event.kind === "rpc" && event.method === "session/new"),
      ).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  test("applies updated additionalModels and replacement models after restart without re-spawning ACP", async () => {
    const dir = await createTempDir("paseo-acp-overlay-");
    const logFile = path.join(dir, "trace.ndjson");
    const cachePath = path.join(dir, "cache", "provider-catalogs.json");
    const binary = await createFakeAcpExecutable({
      dir,
      name: "fake-overlay",
      logFile,
      models: [{ value: "model-v1", name: "Model V1" }],
    });

    const createRegistration = (): ProviderRegistration => ({
      ...runAcpProvider({
        id: "fake-overlay",
        label: "Fake Overlay",
        command: [binary, "acp"],
      }),
      async status() {
        return { available: true };
      },
    });

    // Run 1: discover raw catalog with old-extra additional model.
    const manager1 = new ProviderSnapshotManager({
      logger: createTestLogger(),
      catalogCachePath: cachePath,
      providerOverrides: {
        ...disabledBuiltinsOverrides(),
        "fake-overlay": {
          additionalModels: [{ id: "old-extra", label: "Old Extra" }],
        },
      },
    });
    try {
      manager1.replacePluginProviders([createRegistration()]);
      const entry = await manager1.getProvider({ provider: "fake-overlay", wait: true });
      expect(entry.models?.map((m) => m.id)).toEqual(["model-v1", "old-extra"]);
      expect(acpSpawns(await readEvents(logFile))).toHaveLength(1);
    } finally {
      await manager1.shutdown();
    }

    // Run 2 (stopped config edit): additionalModels changed to new-extra -> 0 spawns, new overlay applied.
    const manager2 = new ProviderSnapshotManager({
      logger: createTestLogger(),
      catalogCachePath: cachePath,
      providerOverrides: {
        ...disabledBuiltinsOverrides(),
        "fake-overlay": {
          additionalModels: [{ id: "new-extra", label: "New Extra" }],
        },
      },
    });
    try {
      manager2.replacePluginProviders([createRegistration()]);
      const entry = await manager2.getProvider({ provider: "fake-overlay", wait: true });
      expect(entry.models?.map((m) => m.id)).toEqual(["model-v1", "new-extra"]);
      expect(acpSpawns(await readEvents(logFile))).toHaveLength(1);
      await expect(
        manager2.validateAgentConfiguration({
          provider: "fake-overlay",
          model: "new-extra",
        }),
      ).resolves.toEqual([]);
    } finally {
      await manager2.shutdown();
    }
  });
});
