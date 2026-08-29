import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../terminal/terminal.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createServiceProxySubsystem } from "./service-proxy.js";
import { WorkspaceLaunchManager } from "./workspace-launch-manager.js";
import { WorkspaceRuntimeEnvironmentService } from "./workspace-runtime-environment.js";

describe("WorkspaceLaunchManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("switches the one active launch while retaining its shared workspace environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: {
          dev: { command: "./bin/dev" },
          full: { command: "./bin/dev --full" },
        },
      }),
    );

    const terminalManager = createTerminalManager();
    const runtimeEnvironment = new WorkspaceRuntimeEnvironmentService();
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: runtimeEnvironment,
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-test",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    const dev = await manager.start(context, "dev");
    expect(dev).toMatchObject({
      launchName: "dev",
      lifecycle: "running",
      active: true,
      portBase: port,
      portEnd: port,
      portCount: 1,
    });
    expect(terminalManager.created[0]?.env).toMatchObject({
      PASEO_PORT_BASE: String(port),
      PASEO_PORT_END: String(port),
      PASEO_PORT_COUNT: "1",
      PASEO_LAUNCH_NAME: "dev",
      COMPOSE_PROJECT_NAME: dev.composeProjectName,
      PASEO_COMPOSE_PROJECT_NAME: dev.composeProjectName,
    });

    const full = await manager.start(context, "full");
    expect(terminalManager.killed).toEqual([dev.terminalId]);
    expect(full).toMatchObject({
      launchName: "full",
      lifecycle: "running",
      active: true,
      portBase: port,
      composeProjectName: dev.composeProjectName,
    });
    expect(manager.buildSnapshot(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchName: "dev", lifecycle: "stopped", active: false }),
        expect.objectContaining({ launchName: "full", lifecycle: "running", active: true }),
      ]),
    );

    await Promise.all([manager.start(context, "dev"), manager.start(context, "full")]);
    expect(manager.buildSnapshot(context).filter((launch) => launch.active)).toEqual([
      expect.objectContaining({ launchName: "full", lifecycle: "running" }),
    ]);

    await manager.stop(context, "full");
    expect(manager.buildSnapshot(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchName: "full", lifecycle: "stopped", active: false }),
      ]),
    );
    await manager.disposeWorkspace(context.workspaceId);
  });

  it("discovers HTTP listeners in the leased block and registers a proxy endpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-proxy-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    const context = {
      workspaceId: "workspace-launch-proxy-test",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const runtimeEnvironment = new WorkspaceRuntimeEnvironmentService();
    await runtimeEnvironment.ensure({
      workspaceId: context.workspaceId,
      cwd: context.workspaceDirectory,
      branchName: context.branchName,
      allocation: { range: `${port}-${port}`, blockSize: 1 },
    });
    const server = http.createServer((_request, response) => response.end("ok"));
    await listen(server, port);
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: runtimeEnvironment,
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });

    try {
      await manager.start(context, "dev");
      await vi.waitFor(() => {
        expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
          expect.objectContaining({
            id: "dev:p0",
            port,
            proxyUrl: expect.stringContaining("launch-dev-p0"),
          }),
        ]);
      });
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      await close(server);
    }
  });
});

function createTerminalManager(): {
  manager: TerminalManager;
  created: Array<{ env: Record<string, string> | undefined }>;
  killed: string[];
} {
  const sessions = new Map<string, TerminalSession>();
  const created: Array<{ env: Record<string, string> | undefined }> = [];
  const killed: string[] = [];
  let nextId = 0;
  const manager = {
    createTerminal: async (options: { env?: Record<string, string> }) => {
      const id = `terminal-${++nextId}`;
      let exitListener: ((info: { exitCode: number | null }) => void) | null = null;
      const terminal = {
        id,
        name: id,
        cwd: "",
        workspaceId: "",
        getState: () => ({ scrollback: [], grid: [[{ char: "$" }]] }),
        subscribe: () => () => {},
        onExit: (listener: (info: { exitCode: number | null }) => void) => {
          exitListener = listener;
          return () => {
            exitListener = null;
          };
        },
        send: vi.fn(),
      } as unknown as TerminalSession;
      sessions.set(id, terminal);
      created.push({ env: options.env });
      // Keep the exit callback with the fake terminal rather than exposing an
      // implementation-only method through the production interface.
      Object.assign(terminal, {
        __exit: () => exitListener?.({ exitCode: 0 }),
      });
      return terminal;
    },
    getTerminal: (id: string) => sessions.get(id),
    killTerminalAndWait: async (id: string) => {
      killed.push(id);
      const terminal = sessions.get(id) as (TerminalSession & { __exit?: () => void }) | undefined;
      terminal?.__exit?.();
      sessions.delete(id);
    },
  } as unknown as TerminalManager;
  return { manager, created, killed };
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to obtain free TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
