import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createPaseoDaemon, parseListenString, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { openPaseoDatabase } from "./db/pglite-database.js";
import { agentSnapshots, projects, workspaces } from "./db/schema.js";

describe("paseo daemon bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      openai: { apiKey: "test-openai-api-key" },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`, {
        headers: daemonHandle.agentMcpAuthHeader
          ? { Authorization: daemonHandle.agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  test("fails fast when OpenAI speech provider is configured without credentials", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-openai-config-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    await mkdir(paseoHome, { recursive: true });

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      await expect(createPaseoDaemon(config, pino({ level: "silent" }))).rejects.toThrow(
        "Missing OpenAI credentials",
      );
    } finally {
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("does not block daemon start on local speech model downloads", async () => {
    const originalFetch = globalThis.fetch;
    let releaseFetch: ((value: Response) => void) | null = null;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchGate),
    );

    const daemonHandle = await createTestPaseoDaemon({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: true },
          voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
        local: {
          modelsDir: path.join(os.tmpdir(), `paseo-missing-models-${Date.now()}`),
          models: {
            dictationStt: "parakeet-tdt-0.6b-v3-int8",
            voiceStt: "parakeet-tdt-0.6b-v3-int8",
            voiceTts: "kokoro-en-v0_19",
          },
        },
      },
    });

    try {
      const response = await originalFetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(response.ok).toBe(true);
    } finally {
      releaseFetch?.(
        new Response(null, {
          status: 500,
          statusText: "test cleanup",
        }),
      );
      await daemonHandle.close();
    }
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\paseo-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\paseo-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
  });

  test("emits a relay pairing offer for unix socket listeners", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-socket-relay-"));
    const paseoHome = path.join(paseoHomeRoot, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const socketPath = path.join(paseoHomeRoot, "run", "paseo.sock");
    await mkdir(path.dirname(socketPath), { recursive: true });
    await mkdir(paseoHome, { recursive: true });

    const lines: string[] = [];
    const logger = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(chunk.toString("utf8"));
          callback();
        },
      }),
    );

    const config: PaseoDaemonConfig = {
      listen: socketPath,
      paseoHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: true,
      relayEndpoint: "127.0.0.1:9",
      relayPublicEndpoint: "127.0.0.1:9",
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };

    const daemon = await createPaseoDaemon(config, logger);

    try {
      await daemon.start();
      expect(lines.some((line) => line.includes('"msg":"pairing_offer"'))).toBe(true);
    } finally {
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("imports legacy project and workspace JSON into the DB on first bootstrap", async () => {
    const { config, cleanup } = await createBootstrapConfig();
    writeLegacyProjectWorkspaceJson(config.paseoHome, {
      projects: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspaces: [
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await daemon.start();
      await daemon.stop();
      const database = await openPaseoDatabase(path.join(config.paseoHome, "db"));
      try {
        expect(await database.db.select().from(projects)).toEqual([
          {
            projectId: "project-1",
            rootPath: "/tmp/project-1",
            kind: "git",
            displayName: "Project One",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-02T00:00:00.000Z",
            archivedAt: null,
          },
        ]);
        expect(await database.db.select().from(workspaces)).toEqual([
          {
            workspaceId: "workspace-1",
            projectId: "project-1",
            cwd: "/tmp/project-1",
            kind: "local_checkout",
            displayName: "main",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-02T00:00:00.000Z",
            archivedAt: null,
          },
        ]);
      } finally {
        await database.close();
      }
    } finally {
      await cleanup();
    }
  });

  test("does not duplicate imported legacy JSON across daemon restarts", async () => {
    const { config, cleanup } = await createBootstrapConfig();
    writeLegacyProjectWorkspaceJson(config.paseoHome, {
      projects: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspaces: [
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    try {
      const firstDaemon = await createPaseoDaemon(config, pino({ level: "silent" }));
      await firstDaemon.start();
      await firstDaemon.stop();

      const secondDaemon = await createPaseoDaemon(config, pino({ level: "silent" }));
      await secondDaemon.start();
      await secondDaemon.stop();

      const database = await openPaseoDatabase(path.join(config.paseoHome, "db"));
      try {
        expect(await database.db.select().from(projects)).toHaveLength(1);
        expect(await database.db.select().from(workspaces)).toHaveLength(1);
      } finally {
        await database.close();
      }
    } finally {
      await cleanup();
    }
  });

  test("reconciles workspace records into the DB without recreating legacy JSON registry files", async () => {
    const { config, cleanup } = await createBootstrapConfig();
    const agentStorageDir = path.join(config.paseoHome, "agents");
    mkdirSync(agentStorageDir, { recursive: true });
    const storageBucket = path.join(agentStorageDir, "tmp-db-only-project");
    mkdirSync(storageBucket, { recursive: true });
    writeFileSync(
      path.join(storageBucket, "agent-1.json"),
      JSON.stringify(
        {
          id: "agent-1",
          provider: "codex",
          cwd: "/tmp/db-only-project",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          lastActivityAt: "2026-03-02T00:00:00.000Z",
          lastUserMessageAt: null,
          title: null,
          labels: {},
          lastStatus: "idle",
          lastModeId: null,
          config: null,
          runtimeInfo: { provider: "codex", sessionId: null },
          persistence: null,
          archivedAt: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
      await daemon.start();
      await daemon.stop();

      const database = await openPaseoDatabase(path.join(config.paseoHome, "db"));
      try {
        expect(await database.db.select().from(agentSnapshots)).toEqual([
          expect.objectContaining({
            agentId: "agent-1",
            cwd: "/tmp/db-only-project",
            requiresAttention: false,
            internal: false,
          }),
        ]);
        expect(await database.db.select().from(projects)).toHaveLength(1);
        expect(await database.db.select().from(workspaces)).toHaveLength(1);
      } finally {
        await database.close();
      }

      expect(existsSync(path.join(config.paseoHome, "projects", "projects.json"))).toBe(false);
      expect(existsSync(path.join(config.paseoHome, "projects", "workspaces.json"))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

async function createBootstrapConfig(): Promise<{
  config: PaseoDaemonConfig;
  cleanup: () => Promise<void>;
}> {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-db-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  await mkdir(paseoHome, { recursive: true });

  return {
    config: {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    },
    cleanup: async () => {
      await rm(paseoHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    },
  };
}

function writeLegacyProjectWorkspaceJson(
  paseoHome: string,
  input: {
    projects: unknown[];
    workspaces: unknown[];
  },
): void {
  const projectsDir = path.join(paseoHome, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(path.join(projectsDir, "projects.json"), JSON.stringify(input.projects, null, 2), "utf8");
  writeFileSync(path.join(projectsDir, "workspaces.json"), JSON.stringify(input.workspaces, null, 2), "utf8");
}
