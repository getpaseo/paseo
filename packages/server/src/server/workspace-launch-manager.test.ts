import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../terminal/terminal.js";
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
      expect(manager.buildSnapshot(context)).toEqual([
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
      await vi.waitFor(() => {
        expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
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

      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
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

      expect(manager.buildSnapshot(context)).toEqual([
        expect.objectContaining({ launchName: "dev", lifecycle: "running" }),
      ]);

      await manager.stop(context, "dev");
      expect(manager.buildSnapshot(context)).toEqual([]);
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
        await manager.start(context, "dev");
        await vi.waitFor(
          () => {
            expect(manager.buildSnapshot(context)).toEqual([
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
      terminalManager.created[0]?.triggerExit(17);

      expect(manager.buildSnapshot(context)).toEqual([
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

      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([]);
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
      expect(manager.buildSnapshot(first)[0]?.endpoints).toHaveLength(1000);
      expect(manager.buildSnapshot(second)[0]?.endpoints).toHaveLength(1000);
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
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const probeHttp = vi.fn().mockResolvedValue(false);
    const manager = new WorkspaceLaunchManager({
      terminalManager: createTerminalManager().manager,
      serviceProxy: createServiceProxySubsystem({ logger: pino({ level: "silent" }) }),
      workspaceRuntimeEnvironment: new WorkspaceRuntimeEnvironmentService(),
      getDaemonTcpPort: () => 6767,
      serviceProxyPublicBaseUrl: null,
      resolveScriptHealth: null,
      endpointProbe: { probeTcp: async () => listening, probeHttp },
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
      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "tcp" }),
      ]);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(1);

      // Failed classifications retry at 5, 10, 20, 40, then at most 60 seconds.
      for (const [index, retryAt] of [6_000, 16_000, 36_000, 76_000, 136_000].entries()) {
        clock.mockReturnValue(retryAt - 1);
        manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
        await flushAsyncWork();
        expect(probeHttp).toHaveBeenCalledTimes(index + 1);
        clock.mockReturnValue(retryAt);
        manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
        await flushAsyncWork();
        expect(probeHttp).toHaveBeenCalledTimes(index + 2);
      }
      probeHttp.mockResolvedValue(true);
      clock.mockReturnValue(196_000);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(7);
      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "http", proxyUrl: expect.any(String) }),
      ]);

      const httpEndpoints = manager.buildSnapshot(context)[0]?.endpoints;
      probeHttp.mockResolvedValue(false);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual(httpEndpoints);
      expect(probeHttp).toHaveBeenCalledTimes(7);

      listening = false;
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([]);
      listening = true;
      probeHttp.mockResolvedValue(true);
      manager.updateWorkspaceBranch(context.workspaceId, context.branchName);
      await flushAsyncWork();
      expect(probeHttp).toHaveBeenCalledTimes(8);
      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
        expect.objectContaining({ port, protocol: "http", proxyUrl: expect.any(String) }),
      ]);
    } finally {
      clock.mockRestore();
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

      expect(manager.buildSnapshot(context)[0]?.endpoints).toEqual([
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

function createTerminalManager(): {
  manager: TerminalManager;
  created: Array<{
    env: Record<string, string> | undefined;
    triggerExit: (exitCode: number | null) => void;
  }>;
  killed: string[];
} {
  const sessions = new Map<string, TerminalSession>();
  const created: Array<{
    env: Record<string, string> | undefined;
    triggerExit: (exitCode: number | null) => void;
  }> = [];
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
      created.push({
        env: options.env,
        triggerExit: (exitCode) => exitListener?.({ exitCode }),
      });
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

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
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
