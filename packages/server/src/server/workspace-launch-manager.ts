import http from "node:http";
import net from "node:net";
import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type {
  WorkspaceLaunchEndpointPayload,
  WorkspaceLaunchPayload,
} from "@getpaseo/protocol/messages";
import type {
  PaseoConfig,
  PaseoServicePortAllocation,
} from "@getpaseo/protocol/paseo-config-schema";
import {
  getExplicitWorkspaceServicePorts,
  getWorkspaceLaunchConfigs,
  paseoConfigParseError,
  readPaseoConfig,
} from "../utils/worktree.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { getAllReservedWorkspaceServicePorts } from "./workspace-service-port-registry.js";
import { waitForTerminalBootstrapReadiness } from "./worktree-bootstrap.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type {
  WorkspaceRuntimeEnvironment,
  WorkspaceRuntimeEnvironmentService,
} from "./workspace-runtime-environment.js";

const LAUNCH_ENDPOINT_SCAN_INTERVAL_MS = 2_000;
const LAUNCH_ENDPOINT_PROBE_TIMEOUT_MS = 300;
const LAUNCH_PROXY_NAMESPACE = "@paseo/launch";

export interface WorkspaceLaunchContext {
  workspaceId: string;
  workspaceDirectory: string;
  /**
   * Launches are project runtime definitions: Project Settings writes them at
   * the source checkout and they are available from every workspace. Scripts
   * remain worktree-scoped, so this is intentionally separate from cwd.
   */
  projectConfigDirectory?: string;
  projectSlug: string;
  branchName: string | null;
}

interface WorkspaceLaunchRuntime {
  launchName: string;
  lifecycle: "running" | "stopped";
  terminalId: string | null;
  exitCode: number | null;
  environment: WorkspaceRuntimeEnvironment;
  context: WorkspaceLaunchContext;
  endpoints: Map<number, LaunchEndpointRuntime>;
  stopListener: (() => void) | null;
  monitor: ReturnType<typeof setInterval> | null;
  scanInFlight: boolean;
}

interface LaunchEndpointRuntime {
  protocol: "http" | "tcp";
  scriptName: string | null;
}

export interface WorkspaceLaunchEndpointProbe {
  probeTcp(port: number): Promise<boolean>;
  probeHttp(port: number): Promise<boolean>;
}

export interface WorkspaceLaunchManagerDependencies {
  terminalManager: TerminalManager | null;
  serviceProxy: ServiceProxySubsystem | null;
  workspaceRuntimeEnvironment: WorkspaceRuntimeEnvironmentService;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore | null;
  getDaemonTcpPort: (() => number | null) | null;
  serviceProxyPublicBaseUrl: string | null;
  globalServicePorts?: PaseoServicePortAllocation;
  resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  emitWorkspaceUpdates?: (workspaceIds: Iterable<string>) => Promise<void>;
  /** Injected by tests so listener lifecycle races can be reproduced deterministically. */
  endpointProbe?: WorkspaceLaunchEndpointProbe;
  logger: Logger;
}

/**
 * Runs one selected workspace runtime at a time. It deliberately owns only the
 * launch terminal and proxy registration; Docker Compose and child processes
 * stay under the user's entrypoint rather than becoming a second process
 * supervisor inside Paseo.
 */
export class WorkspaceLaunchManager {
  private readonly runtimes = new Map<string, Map<string, WorkspaceLaunchRuntime>>();
  private readonly activeLaunches = new Map<string, string>();
  private readonly operationChains = new Map<string, Promise<unknown>>();
  private readonly endpointProbe: WorkspaceLaunchEndpointProbe;

  constructor(private readonly deps: WorkspaceLaunchManagerDependencies) {
    this.endpointProbe = deps.endpointProbe ?? { probeTcp, probeHttp };
  }

  buildSnapshot(context: WorkspaceLaunchContext): WorkspaceLaunchPayload[] {
    const configuredNames = new Set(this.readLaunchConfigNames(this.getConfigDirectory(context)));
    const workspaceRuntimes = this.runtimes.get(context.workspaceId);
    for (const [name, runtime] of workspaceRuntimes ?? []) {
      if (runtime.lifecycle === "running" || configuredNames.has(name)) {
        configuredNames.add(name);
        continue;
      }
      // Configuration is the source of truth for stopped launches. Keep an
      // orphan visible only while it is still running so users can stop it.
      workspaceRuntimes?.delete(name);
    }
    if (workspaceRuntimes?.size === 0) {
      this.runtimes.delete(context.workspaceId);
    }

    return Array.from(configuredNames)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((launchName) => this.toPayload(context, launchName));
  }

  async start(
    context: WorkspaceLaunchContext,
    launchName: string,
  ): Promise<WorkspaceLaunchPayload> {
    return await this.runExclusive(context.workspaceId, () =>
      this.startInternal(context, launchName),
    );
  }

  private async startInternal(
    context: WorkspaceLaunchContext,
    launchName: string,
  ): Promise<WorkspaceLaunchPayload> {
    const configResult = readPaseoConfig(this.getConfigDirectory(context));
    if (!configResult.ok) {
      throw paseoConfigParseError(configResult);
    }
    const config = getWorkspaceLaunchConfigs(configResult.config).get(launchName);
    if (!config) {
      throw new Error(`Launch '${launchName}' is not configured in paseo.json`);
    }
    if (!this.deps.terminalManager || !this.deps.serviceProxy) {
      throw new Error("Workspace launches are not available on this daemon");
    }

    const activeLaunchName = this.activeLaunches.get(context.workspaceId);
    const activeRuntime = activeLaunchName
      ? this.runtimes.get(context.workspaceId)?.get(activeLaunchName)
      : null;
    if (activeLaunchName === launchName && activeRuntime?.lifecycle === "running") {
      return this.toPayload(context, launchName);
    }
    if (activeLaunchName && activeRuntime?.lifecycle === "running") {
      await this.stopRuntime(activeRuntime);
    }

    await this.stopSupersededScript(context, launchName);

    const environment = await this.deps.workspaceRuntimeEnvironment.ensure({
      workspaceId: context.workspaceId,
      cwd: context.workspaceDirectory,
      branchName: context.branchName,
      allocation: configResult.config?.worktree?.servicePorts ?? this.deps.globalServicePorts,
      excludedPorts: () => this.getExcludedServicePorts(context, configResult.config),
    });
    const terminal = await this.deps.terminalManager.createTerminal({
      cwd: context.workspaceDirectory,
      workspaceId: context.workspaceId,
      name: `launch:${launchName}`,
      title: `launch:${launchName}`,
      env: { ...environment.env, PASEO_LAUNCH_NAME: launchName },
    });
    const runtime: WorkspaceLaunchRuntime = {
      launchName,
      lifecycle: "running",
      terminalId: terminal.id,
      exitCode: null,
      environment,
      context,
      endpoints: new Map(),
      stopListener: null,
      monitor: null,
      scanInFlight: false,
    };
    const workspaceRuntimes = this.runtimes.get(context.workspaceId) ?? new Map();
    workspaceRuntimes.set(launchName, runtime);
    this.runtimes.set(context.workspaceId, workspaceRuntimes);
    this.activeLaunches.set(context.workspaceId, launchName);

    let unsubscribeExit: (() => void) | null = null;
    let unsubscribeCommandFinished: (() => void) | null = null;
    runtime.stopListener = () => {
      unsubscribeExit?.();
      unsubscribeExit = null;
      unsubscribeCommandFinished?.();
      unsubscribeCommandFinished = null;
    };
    const stopRuntime = (exitCode: number | null) => {
      this.markStopped(runtime, exitCode);
      void this.emitWorkspaceUpdate(context.workspaceId);
    };
    unsubscribeExit = terminal.onExit((info) => {
      stopRuntime(info.exitCode);
    });
    unsubscribeCommandFinished = terminal.onCommandFinished((info) => {
      stopRuntime(info.exitCode);
    });

    try {
      await waitForTerminalBootstrapReadiness(terminal);
      terminal.send({ type: "input", data: `${config.command}\r` });
      if (this.isCurrentRunningRuntime(runtime)) {
        this.startEndpointMonitor(runtime);
        void this.scanEndpoints(runtime);
      }
      await this.emitWorkspaceUpdate(context.workspaceId);
      return this.toPayload(context, launchName);
    } catch (error) {
      this.markStopped(runtime, null);
      await this.emitWorkspaceUpdate(context.workspaceId);
      throw error;
    }
  }

  async stop(context: WorkspaceLaunchContext, launchName: string): Promise<WorkspaceLaunchPayload> {
    return await this.runExclusive(context.workspaceId, () =>
      this.stopInternal(context, launchName),
    );
  }

  private async stopInternal(
    context: WorkspaceLaunchContext,
    launchName: string,
  ): Promise<WorkspaceLaunchPayload> {
    const runtime = this.runtimes.get(context.workspaceId)?.get(launchName);
    if (!runtime || runtime.lifecycle !== "running") {
      throw new Error(`Launch '${launchName}' is not running`);
    }
    await this.stopRuntime(runtime);
    await this.emitWorkspaceUpdate(context.workspaceId);
    return this.toPayload(context, launchName);
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    await this.runExclusive(workspaceId, async () => {
      await this.disposeWorkspaceInternal(workspaceId);
    });
  }

  updateWorkspaceBranch(workspaceId: string, branchName: string | null): void {
    const runtimes = this.runtimes.get(workspaceId);
    if (!runtimes) return;
    for (const runtime of runtimes.values()) {
      runtime.context = { ...runtime.context, branchName };
      if (runtime.lifecycle === "running") {
        void this.scanEndpoints(runtime);
      }
    }
  }

  private async disposeWorkspaceInternal(workspaceId: string): Promise<void> {
    const runtimes = this.runtimes.get(workspaceId);
    if (runtimes) {
      await Promise.all(
        Array.from(runtimes.values(), async (runtime) => {
          if (runtime.lifecycle === "running") {
            await this.stopRuntime(runtime);
          }
        }),
      );
    }
    this.runtimes.delete(workspaceId);
    this.activeLaunches.delete(workspaceId);
    this.deps.workspaceRuntimeEnvironment.release(workspaceId);
  }

  private async runExclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operationChains.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.operationChains.get(workspaceId) === current) {
        this.operationChains.delete(workspaceId);
      }
    }
  }

  private async stopRuntime(runtime: WorkspaceLaunchRuntime): Promise<void> {
    const terminalId = runtime.terminalId;
    const terminal = terminalId ? this.deps.terminalManager?.getTerminal(terminalId) : null;
    if (terminalId && terminal && this.deps.terminalManager) {
      await this.deps.terminalManager.killTerminalAndWait(terminalId);
    }
    if (runtime.lifecycle === "running") {
      this.markStopped(runtime, null);
    }
  }

  private markStopped(runtime: WorkspaceLaunchRuntime, exitCode: number | null): void {
    if (runtime.lifecycle === "stopped") {
      return;
    }
    runtime.lifecycle = "stopped";
    runtime.exitCode = exitCode;
    runtime.stopListener?.();
    runtime.stopListener = null;
    if (runtime.monitor) {
      clearInterval(runtime.monitor);
      runtime.monitor = null;
    }
    for (const endpoint of runtime.endpoints.values()) {
      if (endpoint.scriptName) {
        this.deps.serviceProxy?.removeWorkspaceService({
          workspaceId: runtime.context.workspaceId,
          scriptName: endpoint.scriptName,
        });
      }
    }
    runtime.endpoints.clear();
    if (this.activeLaunches.get(runtime.context.workspaceId) === runtime.launchName) {
      this.activeLaunches.delete(runtime.context.workspaceId);
    }
  }

  private startEndpointMonitor(runtime: WorkspaceLaunchRuntime): void {
    const monitor = setInterval(() => {
      void this.scanEndpoints(runtime);
    }, LAUNCH_ENDPOINT_SCAN_INTERVAL_MS);
    monitor.unref?.();
    runtime.monitor = monitor;
  }

  private async scanEndpoints(runtime: WorkspaceLaunchRuntime): Promise<void> {
    const serviceProxy = this.deps.serviceProxy;
    if (!this.isCurrentRunningRuntime(runtime) || runtime.scanInFlight || !serviceProxy) {
      return;
    }
    runtime.scanInFlight = true;
    try {
      const ports = Array.from(
        { length: runtime.environment.portCount },
        (_, offset) => runtime.environment.portBase + offset,
      );
      const listeningPortCandidates = await Promise.all(
        ports.map(async (port) => ((await this.endpointProbe.probeTcp(port)) ? port : null)),
      );
      const listeningPorts = new Set(
        listeningPortCandidates.filter((port): port is number => port !== null),
      );
      const httpPorts = new Set(
        (
          await Promise.all(
            Array.from(listeningPorts, async (port) => {
              // Raw services must not receive an HTTP request on every scan. A missing
              // listener removes its classification below, allowing detection on restart.
              if (runtime.endpoints.get(port)?.protocol === "tcp") return null;
              return (await this.endpointProbe.probeHttp(port)) ? port : null;
            }),
          )
        ).filter((port): port is number => port !== null),
      );
      if (!this.isCurrentRunningRuntime(runtime) || this.deps.serviceProxy !== serviceProxy) {
        return;
      }
      let changed = false;

      for (const port of listeningPorts) {
        const protocol = httpPorts.has(port) ? "http" : "tcp";
        const existing = runtime.endpoints.get(port);
        if (existing?.protocol === protocol && (protocol === "tcp" || existing.scriptName)) {
          continue;
        }
        if (existing?.scriptName) {
          serviceProxy.removeWorkspaceService({
            workspaceId: runtime.context.workspaceId,
            scriptName: existing.scriptName,
          });
        }

        if (protocol === "tcp") {
          runtime.endpoints.set(port, { protocol, scriptName: null });
          changed = true;
          continue;
        }

        const offset = port - runtime.environment.portBase;
        // This is an internal proxy identity, not a user-configured script
        // name. Include the workspace ID so it cannot replace a service route
        // with a friendly name such as "launch-dev-p0".
        const scriptName = getLaunchEndpointScriptName(runtime, offset);
        try {
          serviceProxy.registerWorkspaceService({
            workspaceId: runtime.context.workspaceId,
            projectSlug: runtime.context.projectSlug,
            branchName: runtime.context.branchName,
            scriptName,
            port,
            publicBaseUrl: this.deps.serviceProxyPublicBaseUrl,
          });
          runtime.endpoints.set(port, { protocol, scriptName });
          changed = true;
        } catch (error) {
          this.deps.logger.warn(
            {
              err: error,
              workspaceId: runtime.context.workspaceId,
              launchName: runtime.launchName,
              port,
            },
            "Failed to register discovered workspace launch endpoint",
          );
          runtime.endpoints.set(port, { protocol, scriptName: null });
          changed = true;
        }
      }

      for (const [port, endpoint] of Array.from(runtime.endpoints)) {
        if (listeningPorts.has(port)) {
          continue;
        }
        if (endpoint.scriptName) {
          serviceProxy.removeWorkspaceService({
            workspaceId: runtime.context.workspaceId,
            scriptName: endpoint.scriptName,
          });
        }
        runtime.endpoints.delete(port);
        changed = true;
      }

      if (changed) {
        await this.emitWorkspaceUpdate(runtime.context.workspaceId);
      }
    } finally {
      runtime.scanInFlight = false;
    }
  }

  private isCurrentRunningRuntime(runtime: WorkspaceLaunchRuntime): boolean {
    return (
      runtime.lifecycle === "running" &&
      this.runtimes.get(runtime.context.workspaceId)?.get(runtime.launchName) === runtime
    );
  }

  private toPayload(context: WorkspaceLaunchContext, launchName: string): WorkspaceLaunchPayload {
    const runtime = this.getRuntime(context.workspaceId, launchName);
    const environment = this.getRuntimeEnvironment(context.workspaceId, runtime);
    return {
      launchName,
      lifecycle: runtime ? runtime.lifecycle : "stopped",
      active: this.isActiveLaunch(context.workspaceId, launchName, runtime),
      portBase: environment?.portBase ?? null,
      portEnd: environment?.portEnd ?? null,
      portCount: environment?.portCount ?? null,
      composeProjectName: environment?.composeProjectName ?? null,
      endpoints: this.getEndpointPayloads(runtime),
      exitCode: runtime ? runtime.exitCode : null,
      terminalId: runtime ? runtime.terminalId : null,
    };
  }

  private getRuntime(workspaceId: string, launchName: string): WorkspaceLaunchRuntime | null {
    return this.runtimes.get(workspaceId)?.get(launchName) ?? null;
  }

  private getRuntimeEnvironment(
    workspaceId: string,
    runtime: WorkspaceLaunchRuntime | null,
  ): WorkspaceRuntimeEnvironment | null {
    return runtime?.environment ?? this.deps.workspaceRuntimeEnvironment.get(workspaceId);
  }

  private getConfigDirectory(context: WorkspaceLaunchContext): string {
    return context.projectConfigDirectory ?? context.workspaceDirectory;
  }

  private getExcludedServicePorts(
    context: WorkspaceLaunchContext,
    projectConfig: PaseoConfig | null,
  ): Set<number> {
    const ports = getExplicitWorkspaceServicePorts(projectConfig);
    for (const port of getAllReservedWorkspaceServicePorts()) {
      ports.add(port);
    }
    if (this.getConfigDirectory(context) === context.workspaceDirectory) {
      return ports;
    }

    const workspaceConfig = readPaseoConfig(context.workspaceDirectory);
    if (!workspaceConfig.ok) {
      return ports;
    }
    for (const port of getExplicitWorkspaceServicePorts(workspaceConfig.config)) {
      ports.add(port);
    }
    return ports;
  }

  private async stopSupersededScript(
    context: WorkspaceLaunchContext,
    launchName: string,
  ): Promise<void> {
    const runtimeStore = this.deps.scriptRuntimeStore;
    const runtime = runtimeStore?.get({ workspaceId: context.workspaceId, scriptName: launchName });
    if (!runtime || runtime.lifecycle !== "running") {
      return;
    }

    const terminal = this.deps.terminalManager?.getTerminal(runtime.terminalId) ?? null;
    if (terminal && this.deps.terminalManager) {
      await this.deps.terminalManager.killTerminalAndWait(runtime.terminalId);
    }

    this.markSupersededScriptStopped(context, runtime);
  }

  private markSupersededScriptStopped(
    context: WorkspaceLaunchContext,
    runtime: NonNullable<ReturnType<WorkspaceScriptRuntimeStore["get"]>>,
  ): void {
    if (runtime.type === "service") {
      this.deps.serviceProxy?.removeWorkspaceService({
        workspaceId: context.workspaceId,
        scriptName: runtime.scriptName,
      });
    }
    this.deps.scriptRuntimeStore?.set({ ...runtime, lifecycle: "stopped", exitCode: null });
  }

  private isActiveLaunch(
    workspaceId: string,
    launchName: string,
    runtime: WorkspaceLaunchRuntime | null,
  ): boolean {
    return runtime?.lifecycle === "running" && this.activeLaunches.get(workspaceId) === launchName;
  }

  private getEndpointPayloads(
    runtime: WorkspaceLaunchRuntime | null,
  ): WorkspaceLaunchEndpointPayload[] {
    if (!runtime) {
      return [];
    }
    return Array.from(runtime.endpoints.entries())
      .sort(([left], [right]) => left - right)
      .map(([port, endpoint]) => this.toEndpointPayload(runtime, port, endpoint));
  }

  private toEndpointPayload(
    runtime: WorkspaceLaunchRuntime,
    port: number,
    endpoint: LaunchEndpointRuntime,
  ): WorkspaceLaunchEndpointPayload {
    if (!endpoint.scriptName) {
      return {
        id: `${runtime.launchName}:p${port - runtime.environment.portBase}`,
        port,
        hostname: "127.0.0.1",
        protocol: endpoint.protocol,
        localProxyUrl: null,
        publicProxyUrl: null,
        proxyUrl: null,
        health: null,
      };
    }

    const projection = this.deps.serviceProxy?.projectWorkspaceServiceState({
      workspaceId: runtime.context.workspaceId,
      projectSlug: runtime.context.projectSlug,
      branchName: runtime.context.branchName,
      scriptName: endpoint.scriptName,
      daemonPort: this.deps.getDaemonTcpPort?.() ?? null,
      publicBaseUrl: this.deps.serviceProxyPublicBaseUrl,
    });
    const health = this.deps.resolveScriptHealth?.(projection?.hostname ?? "") ?? null;
    return {
      id: `${runtime.launchName}:p${port - runtime.environment.portBase}`,
      port,
      hostname: projection?.hostname ?? endpoint.scriptName,
      protocol: "http",
      localProxyUrl: projection?.localProxyUrl ?? null,
      publicProxyUrl: projection?.publicProxyUrl ?? null,
      proxyUrl: projection?.proxyUrl ?? null,
      health: health === "pending" ? null : health,
    };
  }

  private readLaunchConfigNames(workspaceDirectory: string): string[] {
    const configResult = readPaseoConfig(workspaceDirectory);
    if (!configResult.ok) {
      this.deps.logger.warn(
        { err: configResult.error, configPath: configResult.configPath },
        "Failed to read workspace launch configuration",
      );
      return [];
    }
    return Array.from(getWorkspaceLaunchConfigs(configResult.config).keys());
  }

  private async emitWorkspaceUpdate(workspaceId: string): Promise<void> {
    try {
      await this.deps.emitWorkspaceUpdates?.([workspaceId]);
    } catch (error) {
      this.deps.logger.warn({ err: error, workspaceId }, "Failed to emit workspace launch update");
    }
  }
}

function getLaunchEndpointScriptName(runtime: WorkspaceLaunchRuntime, offset: number): string {
  return `${LAUNCH_PROXY_NAMESPACE}:${runtime.context.workspaceId}:${runtime.launchName}:p${offset}`;
}

async function probeHttp(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "HEAD",
        path: "/",
        timeout: LAUNCH_ENDPOINT_PROBE_TIMEOUT_MS,
        agent: false,
      },
      (response) => {
        response.resume();
        finish(true);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

async function probeTcp(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.setTimeout(LAUNCH_ENDPOINT_PROBE_TIMEOUT_MS);
  });
}
