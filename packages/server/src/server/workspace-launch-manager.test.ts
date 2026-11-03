import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession, WorkspaceLaunchTerminalMetadata } from "../terminal/terminal.js";
import {
  createTerminalManager as createRealTerminalManager,
  type TerminalManager,
} from "../terminal/terminal-manager.js";
import { createServiceProxySubsystem } from "./service-proxy.js";
import { WorkspaceLaunchManager } from "./workspace-launch-manager.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  ensureWorkspaceServicePortPlan,
  releaseWorkspaceServicePortPlan,
} from "./workspace-service-port-registry.js";
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

    terminalManager.failNextCreate();
    await expect(manager.start(context, "full")).rejects.toThrow("Failed to create terminal");
    expect(terminalManager.killed).toEqual([dev.terminalId]);
    expect(await manager.buildSnapshot(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchName: "dev", lifecycle: "running", active: true }),
        expect.objectContaining({ launchName: "full", lifecycle: "stopped", active: false }),
      ]),
    );
    const restoredDev = (await manager.buildSnapshot(context)).find(
      (launch) => launch.launchName === "dev",
    );
    expect(restoredDev?.terminalId).not.toBe(dev.terminalId);

    const full = await manager.start(context, "full");
    expect(terminalManager.killed).toEqual([dev.terminalId, restoredDev?.terminalId]);
    expect(terminalManager.manager.getTerminal(restoredDev!.terminalId!)).toBeDefined();
    expect(full).toMatchObject({
      launchName: "full",
      lifecycle: "running",
      active: true,
      portBase: port,
      composeProjectName: dev.composeProjectName,
    });
    expect(await manager.buildSnapshot(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ launchName: "dev", lifecycle: "stopped", active: false }),
        expect.objectContaining({ launchName: "full", lifecycle: "running", active: true }),
      ]),
    );

    await Promise.all([manager.start(context, "dev"), manager.start(context, "full")]);
    const activeLaunches = (await manager.buildSnapshot(context)).filter((launch) => launch.active);
    expect(activeLaunches).toEqual([
      expect.objectContaining({ launchName: "full", lifecycle: "running" }),
    ]);
    const currentTerminalId = activeLaunches[0]!.terminalId!;
    expect(currentTerminalId).not.toBe(full.terminalId);
    const currentTerminal = terminalManager.manager.getTerminal(currentTerminalId);
    expect(currentTerminal).toMatchObject({ id: currentTerminalId });

    await manager.stop(context, "full");
    expect(terminalManager.manager.getTerminal(currentTerminalId)).toBe(currentTerminal);
    expect(currentTerminal?.getExitInfo()).toEqual({ exitCode: 0 });
    expect(await manager.buildSnapshot(context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          launchName: "full",
          lifecycle: "stopped",
          active: false,
          terminalId: currentTerminalId,
        }),
      ]),
    );
    await manager.disposeWorkspace(context.workspaceId);
  });

  it("recovers a surviving launch terminal and its port block after daemon restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-recovery-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    const terminalManager = createTerminalManager();
    const context = {
      workspaceId: "workspace-launch-recovery",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/recovery",
    };
    const dependencies = {
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async () => false,
        probeHttp: async () => false,
      },
      logger: pino({ level: "silent" }),
    };
    const original = new WorkspaceLaunchManager({
      ...dependencies,
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
    });
    const recovered = new WorkspaceLaunchManager({
      ...dependencies,
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
    });

    try {
      const started = await original.start(context, "dev");
      expect(terminalManager.created[0]?.name).toBe("launch:dev");
      writeFileSync(
        join(directory, "paseo.json"),
        JSON.stringify({
          launches: {
            dev: { command: "./bin/edited-dev" },
            full: { command: "./bin/full" },
          },
        }),
      );
      await recovered.initialize([context]);

      expect(await recovered.buildSnapshot(context)).toEqual([
        expect.objectContaining({
          launchName: "dev",
          lifecycle: "running",
          active: true,
          terminalId: started.terminalId,
          portBase: port,
          portEnd: port,
          portCount: 1,
          composeProjectName: started.composeProjectName,
        }),
        expect.objectContaining({ launchName: "full", lifecycle: "stopped", active: false }),
      ]);
      await expect(recovered.start(context, "dev")).resolves.toMatchObject({
        terminalId: started.terminalId,
      });
      expect(terminalManager.created).toHaveLength(1);

      terminalManager.failNextCreate();
      await expect(recovered.start(context, "full")).rejects.toThrow("Failed to create terminal");
      const restored = (await recovered.buildSnapshot(context)).find((launch) => launch.active)!;
      expect(terminalManager.manager.getTerminal(restored.terminalId!)?.workspaceLaunch).toEqual({
        launchName: "dev",
        command: "./bin/dev",
        portBase: port,
        portCount: 1,
      });
      await recovered.stop(context, "dev");
    } finally {
      await recovered.disposeWorkspace(context.workspaceId);
      await original.disposeWorkspace(context.workspaceId);
    }
  });

  it("reserves every surviving launch block before a different workspace starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-launch-startup-reservations-"));
    tempDirs.push(directory);
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: "42004-42019", blockSize: 8 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    const terminalManager = createTerminalManager();
    const firstContext = {
      workspaceId: "startup-launch-a",
      workspaceDirectory: directory,
      projectSlug: "app",
      branchName: "a",
    };
    const secondContext = { ...firstContext, workspaceId: "startup-launch-b", branchName: "b" };
    const survivingTerminal = await terminalManager.manager.createTerminal({
      cwd: directory,
      workspaceId: firstContext.workspaceId,
      name: "launch:dev",
      retainOnExit: true,
      workspaceLaunch: { launchName: "dev", command: "./bin/dev", portBase: 42000, portCount: 8 },
    });
    const environment = new WorkspaceRuntimeEnvironmentService({
      random: () => 0,
      checkPortAvailable: async () => true,
    });
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: environment,
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      endpointProbe: { probeTcp: async () => false, probeHttp: async () => false },
      logger: pino({ level: "silent" }),
    });
    try {
      await manager.initialize([firstContext, secondContext]);
      const second = await manager.start(secondContext, "dev");
      expect(second).toMatchObject({ portBase: 42008, portEnd: 42015 });
      expect(await manager.buildSnapshot(firstContext)).toEqual([
        expect.objectContaining({
          active: true,
          terminalId: survivingTerminal.id,
          portBase: 42000,
          portEnd: 42007,
        }),
      ]);
      await expect(
        ensureWorkspaceServicePortPlan({
          workspaceId: "startup-service",
          services: [{ scriptName: "api", port: 42004 }],
          getReservedPorts: () => environment.getReservedPorts(),
          allocatePort: async () => {
            throw new Error("No dynamic allocation expected");
          },
        }),
      ).rejects.toThrow("reserved by a workspace runtime block");
    } finally {
      await manager.disposeWorkspace(firstContext.workspaceId);
      await manager.disposeWorkspace(secondContext.workspaceId);
      releaseWorkspaceServicePortPlan("startup-service");
    }
  });

  it("keeps workspace snapshots readable when the terminal worker is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-launch-unavailable-worker-"));
    tempDirs.push(directory);
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    const unavailable = new Error("Terminals are held by a newer Paseo");
    const terminalManager = createTerminalManager({ unavailableError: unavailable });
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "unavailable-worker",
      workspaceDirectory: directory,
      projectSlug: "app",
      branchName: null,
    };
    await manager.initialize([context]);
    expect(await manager.buildSnapshot(context)).toEqual([
      expect.objectContaining({ launchName: "dev", lifecycle: "stopped", terminalId: null }),
    ]);
    await expect(manager.start(context, "dev")).rejects.toThrow(unavailable);
    expect(terminalManager.created).toEqual([]);
  });

  it("releases the shared port before starting a replacement launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-switch-port-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    const command =
      "node -e \"const net=require('node:net');const server=net.createServer((socket)=>socket.end(process.env.PASEO_LAUNCH_NAME));server.listen(Number(process.env.PASEO_PORT_BASE),'127.0.0.1')\"";
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: {
          dev: { command },
          full: { command },
        },
      }),
    );

    const terminalManager = createRealTerminalManager();
    const manager = new WorkspaceLaunchManager({
      terminalManager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-switch-port",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      await manager.start(context, "dev");
      await expect.poll(() => readTcpMessage(port), { timeout: 10_000 }).toBe("dev");

      await manager.start(context, "full");
      await expect.poll(() => readTcpMessage(port), { timeout: 10_000 }).toBe("full");
      expect(await manager.buildSnapshot(context)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ launchName: "dev", lifecycle: "stopped", active: false }),
          expect.objectContaining({ launchName: "full", lifecycle: "running", active: true }),
        ]),
      );
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      terminalManager.killAll();
    }
  });

  it("uses the project launch definition and replaces a same-named legacy service", async () => {
    const projectDirectory = mkdtempSync(join(tmpdir(), "paseo-project-launch-"));
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-"));
    tempDirs.push(projectDirectory, workspaceDirectory);
    const port = await getFreePort();
    writeFileSync(
      join(projectDirectory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/project-dev" } },
      }),
    );
    writeFileSync(
      join(workspaceDirectory, "paseo.json"),
      JSON.stringify({
        scripts: { dev: { type: "service", command: "./bin/legacy-dev" } },
      }),
    );

    const terminalManager = createTerminalManager();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const legacyTerminal = await terminalManager.manager.createTerminal({
      cwd: workspaceDirectory,
      workspaceId: "workspace-project-launch-test",
    });
    runtimeStore.set({
      workspaceId: "workspace-project-launch-test",
      scriptName: "dev",
      type: "service",
      lifecycle: "running",
      terminalId: legacyTerminal.id,
      exitCode: null,
    });
    await ensureWorkspaceServicePortPlan({
      workspaceId: "workspace-project-launch-test",
      services: [{ scriptName: "dev" }],
      allocatePort: async () => port,
    });
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      scriptRuntimeStore: runtimeStore,
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-project-launch-test",
      workspaceDirectory,
      projectConfigDirectory: projectDirectory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      expect(await manager.buildSnapshot(context)).toEqual([
        expect.objectContaining({ launchName: "dev", lifecycle: "stopped" }),
      ]);

      await manager.start(context, "dev");

      expect(terminalManager.killed).toEqual([legacyTerminal.id]);
      expect(
        runtimeStore.get({ workspaceId: context.workspaceId, scriptName: "dev" }),
      ).toMatchObject({
        lifecycle: "stopped",
      });
      expect(terminalManager.created[1]?.env).toMatchObject({
        PASEO_PORT_BASE: String(port),
        PASEO_PORT_END: String(port),
        PASEO_LAUNCH_NAME: "dev",
      });
      expect(terminalManager.created[1]?.env).not.toHaveProperty("PASEO_PORT");
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      releaseWorkspaceServicePortPlan(context.workspaceId);
    }
  });

  it("discovers live TCP listeners and proxies only HTTP endpoints from a project launch", async () => {
    const projectDirectory = mkdtempSync(join(tmpdir(), "paseo-project-launch-proxy-"));
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-proxy-"));
    tempDirs.push(projectDirectory, workspaceDirectory);
    const port = await getFreePortBlock(3);
    const context = {
      workspaceId: "workspace-launch-proxy-test",
      workspaceDirectory,
      projectConfigDirectory: projectDirectory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };
    writeFileSync(
      join(projectDirectory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port + 2}`, blockSize: 3 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    writeFileSync(
      join(workspaceDirectory, "paseo.json"),
      JSON.stringify({
        scripts: { dev: { type: "service", command: "./bin/legacy-dev" } },
      }),
    );

    const runtimeEnvironment = new WorkspaceRuntimeEnvironmentService();
    await runtimeEnvironment.ensure({
      workspaceId: context.workspaceId,
      cwd: context.workspaceDirectory,
      branchName: context.branchName,
      allocation: { range: `${port}-${port + 2}`, blockSize: 3 },
    });
    const firstServer = http.createServer((_request, response) => response.end("ok"));
    const secondServer = net.createServer((socket) => socket.destroy());
    const thirdServer = http.createServer((_request, response) => response.end("ok"));
    await listen(firstServer, port);
    await listen(secondServer, port + 1);
    await listen(thirdServer, port + 2);
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
      await vi.waitFor(async () => {
        expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
          expect.objectContaining({
            id: "dev:p0",
            port,
            proxyUrl: expect.stringContaining("paseo-launch"),
          }),
          {
            id: "dev:p1",
            port: port + 1,
            hostname: "127.0.0.1",
            protocol: "tcp",
            localProxyUrl: null,
            publicProxyUrl: null,
            proxyUrl: null,
            health: null,
          },
          expect.objectContaining({
            id: "dev:p2",
            port: port + 2,
            proxyUrl: expect.stringContaining("paseo-launch"),
          }),
        ]);
      });
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      await close(firstServer);
      await close(secondServer);
      await close(thirdServer);
    }
  });

  it("discovers an HTTP listener bound only to IPv6 loopback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-ipv6-"));
    tempDirs.push(directory);
    const server = http.createServer((_request, response) => response.end("ok"));
    const workspaceRuntimeEnvironment = new WorkspaceRuntimeEnvironmentService();
    const context = {
      workspaceId: "workspace-launch-ipv6",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/ipv6",
    };
    const environment = await workspaceRuntimeEnvironment.ensure({
      workspaceId: context.workspaceId,
      cwd: context.workspaceDirectory,
      branchName: context.branchName,
      allocation: { blockSize: 1 },
    });
    const port = environment.portBase;
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment,
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      logger: pino({ level: "silent" }),
    });

    try {
      await listen(server, port, "::1");
      await manager.start(context, "dev");
      await vi.waitFor(async () => {
        expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
          expect.objectContaining({ port, protocol: "http", proxyUrl: expect.any(String) }),
        ]);
      });
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      await close(server);
    }
  });

  it("keeps a configured service route when a launch discovers an HTTP listener", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-route-"));
    tempDirs.push(directory);
    const launchPort = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${launchPort}-${launchPort}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const serviceProxy = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
    serviceProxy.registerWorkspaceService({
      workspaceId: "workspace-launch-route",
      projectSlug: "example-project",
      branchName: "feature/launch",
      scriptName: "launch-dev-p0",
      port: 30_000,
    });
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy,
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async (candidate) => candidate === launchPort,
        probeHttp: async () => true,
      },
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-route",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      await manager.start(context, "dev");
      await vi.waitFor(() => {
        expect(serviceProxy.getWorkspaceHealthTargets(context.workspaceId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ scriptName: "launch-dev-p0", port: 30_000 }),
            expect.objectContaining({
              scriptName: "@paseo/launch:workspace-launch-route:dev:p0",
              port: launchPort,
            }),
          ]),
        );
      });

      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
        expect.objectContaining({
          hostname: expect.stringContaining("paseo-launch"),
          port: launchPort,
        }),
      ]);

      await manager.stop(context, "dev");
      expect(serviceProxy.getWorkspaceHealthTargets(context.workspaceId)).toEqual([
        expect.objectContaining({ scriptName: "launch-dev-p0", port: 30_000 }),
      ]);
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("keeps a removed launch visible only until its active runtime stops", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-config-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-config",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      await manager.start(context, "dev");
      writeFileSync(join(directory, "paseo.json"), JSON.stringify({ launches: {} }));

      expect(await manager.buildSnapshot(context)).toEqual([
        expect.objectContaining({ launchName: "dev", lifecycle: "running" }),
      ]);

      await manager.stop(context, "dev");
      expect(await manager.buildSnapshot(context)).toEqual([]);
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("preserves retained launch output across a failed configuration read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-launch-config-read-failure-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    const configPath = join(directory, "paseo.json");
    const config = JSON.stringify({
      worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
      launches: { dev: { command: "./bin/dev" } },
    });
    writeFileSync(configPath, config);
    const terminalManager = createTerminalManager();
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-config-read-failure",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      const launch = await manager.start(context, "dev");
      const terminalId = launch.terminalId!;
      const terminal = terminalManager.manager.getTerminal(terminalId);
      expect(terminal).toMatchObject({ id: terminalId });
      terminalManager.created[0]?.triggerExit(17);
      const retainedLaunch = expect.objectContaining({
        launchName: "dev",
        lifecycle: "stopped",
        terminalId,
        exitCode: 17,
      });

      writeFileSync(configPath, "{");
      expect(await manager.buildSnapshot(context)).toEqual([retainedLaunch]);
      expect(terminalManager.manager.getTerminal(terminalId)).toBe(terminal);

      writeFileSync(configPath, config);
      expect(await manager.buildSnapshot(context)).toEqual([retainedLaunch]);
      expect(terminalManager.manager.getTerminal(terminalId)).toBe(terminal);

      writeFileSync(configPath, JSON.stringify({ launches: {} }));
      expect(await manager.buildSnapshot(context)).toEqual([]);
      expect(terminalManager.manager.getTerminal(terminalId)).toBeUndefined();
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("keeps dynamic service leases from every workspace outside the launch port block", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-planned-port-"));
    tempDirs.push(directory);
    const plannedServicePort = 44_000;
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: "44000-44200" } },
        scripts: { api: { type: "service", command: "./bin/api" } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const context = {
      workspaceId: "workspace-launch-planned-port",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };
    const serviceWorkspaceId = "workspace-launch-planned-port-service";
    await ensureWorkspaceServicePortPlan({
      workspaceId: serviceWorkspaceId,
      services: [{ scriptName: "api" }],
      allocatePort: async () => plannedServicePort,
    });
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService({
        random: () => 0,
        checkPortAvailable: async () => true,
      }),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async () => false,
        probeHttp: async () => false,
      },
      logger: pino({ level: "silent" }),
    });

    try {
      const launch = await manager.start(context, "dev");

      expect(launch).toMatchObject({
        portBase: plannedServicePort + 1,
        portEnd: plannedServicePort + 100,
      });
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
      releaseWorkspaceServicePortPlan(serviceWorkspaceId);
    }
  });

  it("does not exclude a superseded service port from its launch block", async () => {
    const projectDirectory = mkdtempSync(join(tmpdir(), "paseo-launch-superseded-project-"));
    const workspaceDirectory = mkdtempSync(join(tmpdir(), "paseo-launch-superseded-worktree-"));
    tempDirs.push(projectDirectory, workspaceDirectory);
    writeFileSync(
      join(projectDirectory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: "43000-43003", blockSize: 4 } },
        scripts: { dev: { type: "service", command: "./bin/legacy-dev", port: 43000 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    writeFileSync(
      join(workspaceDirectory, "paseo.json"),
      JSON.stringify({
        scripts: { dev: { type: "service", command: "./bin/worktree-dev", port: 43000 } },
      }),
    );
    const context = {
      workspaceId: "workspace-launch-superseded-port",
      workspaceDirectory,
      projectConfigDirectory: projectDirectory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService({
        random: () => 0,
        checkPortAvailable: async () => true,
      }),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: { probeTcp: async () => false, probeHttp: async () => false },
      logger: pino({ level: "silent" }),
    });

    try {
      await expect(manager.start(context, "dev")).resolves.toMatchObject({
        portBase: 43000,
        portEnd: 43003,
        portCount: 4,
      });
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("waits for an in-flight service plan before leasing a launch port block", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-service-race-"));
    tempDirs.push(directory);
    const plannedServicePort = 44_000;
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: "44000-44200" } },
        scripts: { api: { type: "service", command: "./bin/api" } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const context = {
      workspaceId: "workspace-launch-service-race",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };
    const serviceWorkspaceId = "workspace-launch-service-race-service";
    const servicePlanStarted = createDeferred();
    const allowServicePlan = createDeferred();
    const servicePlan = ensureWorkspaceServicePortPlan({
      workspaceId: serviceWorkspaceId,
      services: [{ scriptName: "api" }],
      allocatePort: async () => {
        servicePlanStarted.resolve();
        await allowServicePlan.promise;
        return plannedServicePort;
      },
    });
    await servicePlanStarted.promise;

    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService({
        random: () => 0,
        checkPortAvailable: async () => true,
      }),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async () => false,
        probeHttp: async () => false,
      },
      logger: pino({ level: "silent" }),
    });

    try {
      const launch = manager.start(context, "dev");
      await flushAsyncWork();
      allowServicePlan.resolve();
      await servicePlan;

      await expect(launch).resolves.toMatchObject({
        portBase: plannedServicePort + 1,
        portEnd: plannedServicePort + 100,
      });
    } finally {
      allowServicePlan.resolve();
      await manager.disposeWorkspace(context.workspaceId);
      releaseWorkspaceServicePortPlan(serviceWorkspaceId);
    }
  });

  it.each([0, 17])(
    "observes real command exit %i without interactive shell integration",
    async (exitCode) => {
      const directory = mkdtempSync(join(tmpdir(), "paseo-launch-process-exit-"));
      tempDirs.push(directory);
      writeFileSync(
        join(directory, "paseo.json"),
        JSON.stringify({
          worktree: { servicePorts: { blockSize: 1 } },
          launches: { dev: { command: `echo launch-output; exit ${exitCode}` } },
        }),
      );
      const terminalManager = createRealTerminalManager();
      const manager = new WorkspaceLaunchManager({
        terminalManager,
        serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
        workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
        getDaemonTcpPort: () => 6767,
        serviceProxyPublicBaseUrl: null,
        resolveScriptHealth: null,
        logger: pino({ level: "silent" }),
      });
      const context = {
        workspaceId: "real-exit",
        workspaceDirectory: directory,
        projectSlug: "app",
        branchName: null,
      };
      try {
        const launch = await manager.start(context, "dev");
        await vi.waitFor(
          async () => {
            expect(await manager.buildSnapshot(context)).toEqual([
              expect.objectContaining({
                lifecycle: "stopped",
                active: false,
                exitCode,
                endpoints: [],
              }),
            ]);
          },
          { timeout: 10_000 },
        );
        if (!launch.terminalId) {
          throw new Error("Expected launch terminal ID");
        }
        expect(terminalManager.getTerminal(launch.terminalId)).toBeDefined();
        const captured = await terminalManager.captureTerminal(launch.terminalId, {
          stripAnsi: true,
        });
        expect(captured.lines.join("\n")).toContain("launch-output");
      } finally {
        await manager.disposeWorkspace(context.workspaceId);
        terminalManager.killAll();
      }
    },
  );

  it("marks a launch stopped when its foreground command finishes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-command-finished-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const terminalManager = createTerminalManager();
    const manager = new WorkspaceLaunchManager({
      terminalManager: terminalManager.manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-command-finished",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      await manager.start(context, "dev");
      expect(terminalManager.created[0]?.retainOnExit).toBe(true);
      terminalManager.created[0]?.triggerExit(17);

      expect(await manager.buildSnapshot(context)).toEqual([
        expect.objectContaining({
          launchName: "dev",
          lifecycle: "stopped",
          active: false,
          exitCode: 17,
        }),
      ]);
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("does not register endpoints after a launch stops while probes are pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-stop-race-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    const probeStarted = createDeferred();
    const continueProbe = createDeferred();
    const serviceProxy = createServiceProxySubsystem({ logger: pino({ level: "silent" }) });
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy,
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async () => {
          probeStarted.resolve();
          await continueProbe.promise;
          return true;
        },
        probeHttp: async () => true,
      },
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "workspace-launch-stop-race",
      workspaceDirectory: directory,
      projectSlug: "example-project",
      branchName: "feature/launch",
    };

    try {
      await manager.start(context, "dev");
      await probeStarted.promise;
      await manager.stop(context, "dev");
      continueProbe.resolve();
      await flushAsyncWork();

      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([]);
      expect(serviceProxy.getWorkspaceHealthTargets(context.workspaceId)).toEqual([]);
    } finally {
      continueProbe.resolve();
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("bounds TCP and HTTP probes across large concurrent workspace scans", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-launch-probe-limit-"));
    tempDirs.push(directory);
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: "30000-31999", blockSize: 1000 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    const allowTcp = createDeferred();
    const allowHttp = createDeferred();
    let active = 0;
    let peak = 0;
    const probeTcp = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await allowTcp.promise;
      active -= 1;
      return true;
    });
    const probeHttp = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await allowHttp.promise;
      active -= 1;
      return false;
    });
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService({
        random: () => 0,
        checkPortAvailable: async () => true,
      }),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      endpointProbe: { probeTcp, probeHttp },
      logger: pino({ level: "silent" }),
    });
    const first = {
      workspaceId: "probe-limit-1",
      workspaceDirectory: directory,
      projectSlug: "app",
      branchName: "one",
    };
    const second = { ...first, workspaceId: "probe-limit-2", branchName: "two" };
    try {
      await Promise.all([manager.start(first, "dev"), manager.start(second, "dev")]);
      await flushAsyncWork();
      expect(probeTcp).toHaveBeenCalledTimes(16);
      expect(peak).toBe(16);
      allowTcp.resolve();
      await flushAsyncWork();
      expect(probeTcp).toHaveBeenCalledTimes(2000);
      expect(probeHttp).toHaveBeenCalledTimes(16);
      expect(peak).toBe(16);
      allowHttp.resolve();
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(2000);
      expect(peak).toBe(16);
      expect(active).toBe(0);
      expect((await manager.buildSnapshot(first))[0]?.endpoints).toHaveLength(1000);
      expect((await manager.buildSnapshot(second))[0]?.endpoints).toHaveLength(1000);
    } finally {
      allowTcp.resolve();
      allowHttp.resolve();
      await manager.disposeWorkspace(first.workspaceId);
      await manager.disposeWorkspace(second.workspaceId);
    }
  });

  it("backs off HTTP retries, discovers slow servers, and resets after disappearance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-launch-probe-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );
    let listening = true;
    let now = 1_000;
    const probeHttp = vi.fn().mockResolvedValue(false);
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      endpointProbe: { probeTcp: async () => listening, probeHttp },
      now: () => now,
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "ws",
      workspaceDirectory: directory,
      projectSlug: "app",
      branchName: "feature",
    };
    try {
      await manager.start(context, "dev");
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledExactlyOnceWith(port);
      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "tcp" }),
      ]);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(1);

      // Failed classifications retry at 5, 10, 20, 40, then at most 60 seconds.
      for (const [index, retryAt] of [6_000, 16_000, 36_000, 76_000, 136_000].entries()) {
        now = retryAt - 1;
        manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
        await flushAsyncWork();
        expect(probeHttp).toHaveBeenCalledTimes(index + 1);
        now = retryAt;
        manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
        await flushAsyncWork();
        expect(probeHttp).toHaveBeenCalledTimes(index + 2);
      }
      probeHttp.mockResolvedValue(true);
      now = 196_000;
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(7);
      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "http", proxyUrl: expect.any(String) }),
      ]);

      const httpEndpoints = (await manager.buildSnapshot(context))[0]?.endpoints;
      probeHttp.mockResolvedValue(false);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual(httpEndpoints);
      expect(probeHttp).toHaveBeenCalledTimes(7);

      listening = false;
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([]);
      listening = true;
      probeHttp.mockResolvedValue(true);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(8);
      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "http", proxyUrl: expect.any(String) }),
      ]);
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });

  it("uses the latest branch when it discovers a launch endpoint after a rename", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-workspace-launch-branch-"));
    tempDirs.push(directory);
    const port = await getFreePort();
    writeFileSync(
      join(directory, "paseo.json"),
      JSON.stringify({
        worktree: { servicePorts: { range: `${port}-${port}`, blockSize: 1 } },
        launches: { dev: { command: "./bin/dev" } },
      }),
    );

    let portIsListening = false;
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      emitWorkspaceUpdates: async () => {},
      endpointProbe: {
        probeTcp: async (candidate) => candidate === port && portIsListening,
        probeHttp: async () => true,
      },
      logger: pino({ level: "silent" }),
    });
    const context = {
      workspaceId: "ws",
      workspaceDirectory: directory,
      projectSlug: "app",
      branchName: "feature/original",
    };

    try {
      await manager.start(context, "dev");
      await flushAsyncWork();
      portIsListening = true;
      manager.updateWorkspaceBranch(context.workspaceId, "feature/renamed");
      await flushAsyncWork();

      expect((await manager.buildSnapshot(context))[0]?.endpoints).toEqual([
        expect.objectContaining({
          port,
          hostname: "paseo-launch-ws-dev-p0--feature-renamed--app.localhost",
          proxyUrl: "http://paseo-launch-ws-dev-p0--feature-renamed--app.localhost:6767",
        }),
      ]);
    } finally {
      await manager.disposeWorkspace(context.workspaceId);
    }
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createTerminalManager(managerOptions: { unavailableError?: Error } = {}): {
  manager: TerminalManager;
  created: Array<{
    env: Record<string, string> | undefined;
    name: string;
    retainOnExit: boolean;
    triggerExit: (exitCode: number | null) => void;
  }>;
  killed: string[];
  failNextCreate: () => void;
} {
  const sessions = new Map<string, TerminalSession>();
  const created: Array<{
    env: Record<string, string> | undefined;
    name: string;
    retainOnExit: boolean;
    triggerExit: (exitCode: number | null) => void;
  }> = [];
  const killed: string[] = [];
  let nextId = 0;
  let failNextCreate = false;
  const unavailableError = managerOptions.unavailableError;
  const manager = {
    getUnavailableError: () => unavailableError ?? null,
    listDirectories: () =>
      Array.from(new Set(Array.from(sessions.values(), (session) => session.cwd))),
    createTerminal: async (options: {
      cwd: string;
      workspaceId: string;
      name?: string;
      env?: Record<string, string>;
      retainOnExit?: boolean;
      workspaceLaunch?: WorkspaceLaunchTerminalMetadata;
    }) => {
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error("Failed to create terminal");
      }
      const id = `terminal-${++nextId}`;
      let exitListener: ((info: { exitCode: number | null }) => void) | null = null;
      let exitInfo: { exitCode: number | null } | null = null;
      const triggerExit = (exitCode: number | null) => {
        exitInfo = { exitCode };
        exitListener?.(exitInfo);
      };
      const terminal = {
        id,
        name: options.name ?? id,
        cwd: options.cwd,
        workspaceId: options.workspaceId,
        workspaceLaunch: options.workspaceLaunch,
        getState: () => ({ scrollback: [], grid: [[{ char: "$" }]] }),
        subscribe: () => () => {},
        onExit: (listener: (info: { exitCode: number | null }) => void) => {
          if (exitInfo) {
            queueMicrotask(() => listener(exitInfo!));
            return () => {};
          }
          exitListener = listener;
          return () => {
            exitListener = null;
          };
        },
        getExitInfo: () => exitInfo,
        send: vi.fn(),
      } as unknown as TerminalSession;
      sessions.set(id, terminal);
      created.push({
        env: options.env,
        name: terminal.name,
        retainOnExit: options.retainOnExit === true,
        triggerExit,
      });
      // Keep the exit callback with the fake terminal rather than exposing an
      // implementation-only method through the production interface.
      Object.assign(terminal, {
        __exit: () => triggerExit(0),
      });
      return terminal;
    },
    getTerminals: async (cwd: string, options?: { workspaceId?: string }) => {
      if (unavailableError) throw unavailableError;
      return Array.from(sessions.values()).filter(
        (session) =>
          session.cwd === cwd &&
          (options?.workspaceId === undefined || session.workspaceId === options.workspaceId),
      );
    },
    getTerminal: (id: string) => sessions.get(id),
    killTerminal: (id: string) => {
      sessions.delete(id);
    },
    killTerminalAndWait: async (id: string, options?: { preserveSession?: boolean }) => {
      killed.push(id);
      const terminal = sessions.get(id) as (TerminalSession & { __exit?: () => void }) | undefined;
      terminal?.__exit?.();
      if (!options?.preserveSession) sessions.delete(id);
    },
  } as unknown as TerminalManager;
  return {
    manager,
    created,
    killed,
    failNextCreate: () => {
      failNextCreate = true;
    },
  };
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

async function readTcpMessage(port: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Timed out reading launch listener on port ${port}`));
    });
    socket.setTimeout(500);
  });
}

async function getFreePortBlock(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = await getFreePort();
    if (base + count - 1 > 65_535) {
      continue;
    }
    const reservations = Array.from({ length: count }, () => net.createServer());
    try {
      await Promise.all(reservations.map((server, offset) => listen(server, base + offset)));
      return base;
    } catch {
      // A neighboring port became busy while choosing the block. Try again.
    } finally {
      await Promise.all(reservations.map((server) => close(server)));
    }
  }
  throw new Error(`Failed to find ${count} adjacent free ports`);
}

async function listen(server: net.Server, port: number, host = "127.0.0.1"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
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
