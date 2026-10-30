import type { Logger } from "pino";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import {
  getScriptConfigs,
  getWorktreeTerminalSpecs,
  isServiceScript,
  paseoConfigParseError,
  processCarriageReturns,
  readPaseoConfig,
  runWorktreeSetupCommands,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
  type WorktreeRuntimeEnv,
} from "../utils/worktree.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { allocateWorkspaceServicePort } from "./workspace-service-port-allocator.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { ToolCallDetail } from "./agent/agent-sdk-types.js";
import {
  assertNoServiceEnvNameCollisions,
  buildWorkspaceServiceEnv,
  type WorkspaceServicePeer,
} from "./workspace-service-env.js";
import {
  ensureWorkspaceServicePortPlan,
  requirePlannedWorkspaceServicePort,
  refreshWorkspaceServicePort,
} from "./workspace-service-port-registry.js";
import type { PaseoServicePortAllocation } from "@getpaseo/protocol/paseo-config-schema";

const MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES = 64 * 1024;
const WORKTREE_SETUP_TRUNCATION_MARKER = "\n...<output truncated in the middle>...\n";
const WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS = 1_500;

interface MiddleTruncationAccumulator {
  totalBytes: number;
  head: string;
  tail: string;
  truncated: boolean;
}

export type WorktreeSetupOutputAccumulator = MiddleTruncationAccumulator;
export interface WorktreeSetupProgressAccumulator {
  resultsByIndex: Map<number, WorktreeSetupCommandResult>;
  outputAccumulatorsByIndex: Map<number, WorktreeSetupOutputAccumulator>;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceFirstBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function sliceLastBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

export function createWorktreeSetupOutputAccumulator(): WorktreeSetupOutputAccumulator {
  return {
    totalBytes: 0,
    head: "",
    tail: "",
    truncated: false,
  };
}

function getHeadTailBudgets(maxBytes: number): { headBytes: number; tailBytes: number } {
  const markerBytes = byteLength(WORKTREE_SETUP_TRUNCATION_MARKER);
  const availableBytes = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(availableBytes / 2);
  const tailBytes = availableBytes - headBytes;
  return { headBytes, tailBytes };
}

export function appendWorktreeSetupOutputAccumulator(
  accumulator: WorktreeSetupOutputAccumulator,
  chunk: string,
): void {
  if (!chunk) {
    return;
  }
  accumulator.totalBytes += byteLength(chunk);

  if (!accumulator.truncated) {
    const combined = `${accumulator.head}${chunk}`;
    if (byteLength(combined) <= MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES) {
      accumulator.head = combined;
      return;
    }
    const { headBytes, tailBytes } = getHeadTailBudgets(MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES);
    accumulator.head = sliceFirstBytes(combined, headBytes);
    accumulator.tail = sliceLastBytes(combined, tailBytes);
    accumulator.truncated = true;
    return;
  }

  const { tailBytes } = getHeadTailBudgets(MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES);
  accumulator.tail = sliceLastBytes(`${accumulator.tail}${chunk}`, tailBytes);
}

function truncateTextInMiddle(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0 || !text) {
    return { text: "", truncated: text.length > 0 };
  }
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const { headBytes, tailBytes } = getHeadTailBudgets(maxBytes);
  return {
    text: `${sliceFirstBytes(text, headBytes)}${WORKTREE_SETUP_TRUNCATION_MARKER}${sliceLastBytes(text, tailBytes)}`,
    truncated: true,
  };
}

function renderMiddleTruncationAccumulator(accumulator: MiddleTruncationAccumulator): {
  text: string;
  truncated: boolean;
} {
  if (!accumulator.truncated) {
    return { text: accumulator.head, truncated: false };
  }
  return {
    text: `${accumulator.head}${WORKTREE_SETUP_TRUNCATION_MARKER}${accumulator.tail}`,
    truncated: true,
  };
}

function commandStatusFromResult(
  result: WorktreeSetupCommandResult,
): "running" | "completed" | "failed" {
  if (result.exitCode === null) {
    return "running";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

function buildWorktreeSetupCommandLog(input: {
  index: number;
  result: WorktreeSetupCommandResult;
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
}): { log: string; truncated: boolean } {
  const { index, result, outputAccumulatorsByIndex } = input;
  const accumulator = outputAccumulatorsByIndex?.get(index);
  const rendered = accumulator
    ? renderMiddleTruncationAccumulator(accumulator)
    : truncateTextInMiddle(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
        MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES,
      );

  return {
    log: processCarriageReturns(rendered.text),
    truncated: rendered.truncated,
  };
}

export function createWorktreeSetupProgressAccumulator(): WorktreeSetupProgressAccumulator {
  return {
    resultsByIndex: new Map(),
    outputAccumulatorsByIndex: new Map(),
  };
}

export function applyWorktreeSetupProgressEvent(
  accumulator: WorktreeSetupProgressAccumulator,
  event: Parameters<NonNullable<Parameters<typeof runWorktreeSetupCommands>[0]["onEvent"]>>[0],
): void {
  const existing = accumulator.resultsByIndex.get(event.index);
  const baseResult: WorktreeSetupCommandResult = existing ?? {
    command: event.command,
    cwd: event.cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    durationMs: 0,
  };

  if (event.type === "output") {
    const outputAccumulator =
      accumulator.outputAccumulatorsByIndex.get(event.index) ??
      createWorktreeSetupOutputAccumulator();
    appendWorktreeSetupOutputAccumulator(outputAccumulator, event.chunk);
    accumulator.outputAccumulatorsByIndex.set(event.index, outputAccumulator);
    accumulator.resultsByIndex.set(event.index, {
      ...baseResult,
      stdout: baseResult.stdout,
      stderr: baseResult.stderr,
    });
    return;
  }

  if (event.type === "command_completed") {
    accumulator.resultsByIndex.set(event.index, {
      ...baseResult,
      stdout: event.stdout,
      stderr: event.stderr,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
    });
    return;
  }

  accumulator.resultsByIndex.set(event.index, baseResult);
}

export function getWorktreeSetupProgressResults(
  accumulator: WorktreeSetupProgressAccumulator,
): WorktreeSetupCommandResult[] {
  return Array.from(accumulator.resultsByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, result]) => result);
}

export function buildWorktreeSetupDetail(input: {
  worktree: WorktreeConfig;
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
}): Extract<ToolCallDetail, { type: "worktree_setup" }> {
  let anyCommandTruncated = false;
  const commands = input.results.map((result, index) => {
    const renderedLog = buildWorktreeSetupCommandLog({
      index: index + 1,
      result,
      outputAccumulatorsByIndex: input.outputAccumulatorsByIndex,
    });
    if (renderedLog.truncated) {
      anyCommandTruncated = true;
    }
    return {
      index: index + 1,
      command: result.command,
      cwd: result.cwd,
      log: renderedLog.log,
      status: commandStatusFromResult(result),
      exitCode: result.exitCode,
      ...(result.durationMs > 0 ? { durationMs: result.durationMs } : {}),
    };
  });
  return {
    type: "worktree_setup",
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
    // COMPAT(workspaceSetupCombinedLog): added in v0.12.0, remove after 2027-04-20 once legacy wire schemas no longer require log.
    // Setup clients render commands[].log; retain the required wire field without duplicating output.
    log: "",
    commands,
    ...(anyCommandTruncated ? { truncated: true } : {}),
  };
}

async function waitForTerminalBootstrapReadiness(
  terminal: Pick<TerminalSession, "getState" | "subscribe">,
): Promise<void> {
  if (terminalHasOutput(terminal.getState())) {
    return;
  }

  await new Promise<void>((resolve) => {
    let pendingResolve: (() => void) | null = resolve;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = () => {
      if (!pendingResolve) {
        return;
      }
      const fn = pendingResolve;
      pendingResolve = null;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      fn();
    };

    unsubscribe = terminal.subscribe((message) => {
      if (message.type !== "output") {
        return;
      }
      finish();
    });

    if (terminalHasOutput(terminal.getState())) {
      finish();
      return;
    }

    timeout = setTimeout(finish, WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS);
  });
}

function terminalHasOutput(state: ReturnType<TerminalSession["getState"]>): boolean {
  for (const row of [...state.scrollback, ...state.grid]) {
    for (const cell of row) {
      if (cell.char.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

export async function runWorktreeAutoTerminals(options: {
  workspaceId: string;
  worktree: WorktreeConfig;
  workspaceCwd: string;
  runtimeEnv: WorktreeRuntimeEnv;
  terminalManager: TerminalManager | null;
  logger?: Logger;
}): Promise<void> {
  if (!options.terminalManager) return;
  const terminalManager = options.terminalManager;
  await Promise.all(
    (await getWorktreeTerminalSpecs(options.workspaceCwd)).map(async (spec) => {
      try {
        const terminal = await terminalManager.createTerminal({
          cwd: options.workspaceCwd,
          name: spec.name,
          env: options.runtimeEnv,
          workspaceId: options.workspaceId,
        });
        await waitForTerminalBootstrapReadiness(terminal);
        terminal.send({ type: "input", data: `${spec.command}\r` });
      } catch (error) {
        options.logger?.warn(
          { workspaceId: options.workspaceId, command: spec.command, err: error },
          "Failed to bootstrap worktree terminal",
        );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Script lifecycle helpers
// ---------------------------------------------------------------------------

export interface WorktreeScriptResult {
  scriptName: string;
  hostname: string | null;
  port: number | null;
  terminalId: string;
}

export interface SpawnWorkspaceScriptOptions {
  repoRoot: string;
  workspaceId: string;
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
  daemonPort?: number | null;
  daemonListenHost?: string | null;
  serviceProxyPublicBaseUrl?: string | null;
  serviceProxy: ServiceProxySubsystem;
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  globalServicePorts?: PaseoServicePortAllocation;
  logger?: Logger;
  onLifecycleChanged?: () => void;
}

interface ServiceScriptSetupResult {
  hostname: string;
  port: number;
  env: Record<string, string>;
}

async function setupServiceScriptRoute(params: {
  repoRoot: string;
  scriptConfigs: ReturnType<typeof getScriptConfigs>;
  config: { port?: number };
  scriptName: string;
  projectSlug: string;
  branchName: string | null;
  workspaceId: string;
  daemonPort: number | null | undefined;
  daemonListenHost: string | null | undefined;
  serviceProxyPublicBaseUrl: string | null | undefined;
  existingRuntimeEntry: ReturnType<WorkspaceScriptRuntimeStore["get"]>;
  serviceProxy: ServiceProxySubsystem;
  servicePortAllocation: PaseoServicePortAllocation | undefined;
}): Promise<ServiceScriptSetupResult> {
  const {
    scriptConfigs,
    repoRoot,
    config,
    scriptName,
    projectSlug,
    branchName,
    workspaceId,
    daemonPort,
    daemonListenHost,
    serviceProxyPublicBaseUrl,
    existingRuntimeEntry,
    serviceProxy,
    servicePortAllocation,
  } = params;

  const serviceDeclarations: Array<{ scriptName: string; port?: number }> = [];
  for (const [configuredScriptName, scriptConfig] of scriptConfigs) {
    if (isServiceScript(scriptConfig)) {
      serviceDeclarations.push({
        scriptName: configuredScriptName,
        port: scriptConfig.port,
      });
    }
  }
  assertNoServiceEnvNameCollisions(
    serviceDeclarations.map((serviceDeclaration) => serviceDeclaration.scriptName),
  );

  const plannedPorts = await ensureWorkspaceServicePortPlan({
    workspaceId,
    services: serviceDeclarations,
    allocatePort: ({ scriptName: serviceScriptName, reservedPorts }) =>
      allocateWorkspaceServicePort({
        allocation: servicePortAllocation,
        cwd: repoRoot,
        scriptName: serviceScriptName,
        workspaceId,
        branchName,
        reservedPorts,
      }),
  });
  const port =
    existingRuntimeEntry?.lifecycle === "stopped"
      ? await refreshWorkspaceServicePort({
          workspaceId,
          service: { scriptName, port: config.port },
          allocatePort: ({ scriptName: serviceScriptName, reservedPorts }) =>
            allocateWorkspaceServicePort({
              allocation: servicePortAllocation,
              cwd: repoRoot,
              scriptName: serviceScriptName,
              workspaceId,
              branchName,
              reservedPorts,
            }),
        })
      : requirePlannedWorkspaceServicePort(plannedPorts, scriptName);

  const peers: WorkspaceServicePeer[] = [];
  for (const [peerScriptName, peerPort] of plannedPorts) {
    peers.push({
      scriptName: peerScriptName,
      port: peerScriptName === scriptName ? port : peerPort,
    });
  }

  const env = buildWorkspaceServiceEnv({
    scriptName,
    projectSlug,
    branchName,
    daemonPort,
    daemonListenHost,
    serviceProxyPublicBaseUrl,
    peers,
  });

  const registeredRoute = serviceProxy.registerWorkspaceService({
    port,
    workspaceId,
    projectSlug,
    branchName,
    scriptName,
    publicBaseUrl: serviceProxyPublicBaseUrl ?? null,
  });
  return { hostname: registeredRoute.hostname, port, env };
}

async function acquireWorkspaceScriptTerminal(params: {
  serviceScript: boolean;
  existingRuntimeEntry: ReturnType<WorkspaceScriptRuntimeStore["get"]>;
  terminalManager: TerminalManager;
  repoRoot: string;
  workspaceId: string;
  scriptName: string;
  env: Record<string, string> | undefined;
}): Promise<{ terminal: TerminalSession; reusableTerminal: TerminalSession | null }> {
  const {
    serviceScript,
    existingRuntimeEntry,
    terminalManager,
    repoRoot,
    workspaceId,
    scriptName,
    env,
  } = params;
  let reusableTerminal: TerminalSession | null = null;
  if (!serviceScript && existingRuntimeEntry?.terminalId) {
    reusableTerminal = terminalManager.getTerminal(existingRuntimeEntry.terminalId) ?? null;
  }
  const terminal =
    reusableTerminal ??
    (await terminalManager.createTerminal({
      cwd: repoRoot,
      workspaceId,
      name: scriptName,
      title: scriptName,
      env,
    }));
  return { terminal, reusableTerminal };
}

export async function spawnWorkspaceScript(
  options: SpawnWorkspaceScriptOptions,
): Promise<WorktreeScriptResult> {
  const {
    repoRoot,
    workspaceId,
    projectSlug,
    branchName,
    scriptName,
    daemonPort,
    daemonListenHost,
    serviceProxyPublicBaseUrl,
    serviceProxy,
    runtimeStore,
    terminalManager,
    globalServicePorts,
    logger,
    onLifecycleChanged,
  } = options;
  const configResult = await readPaseoConfig(repoRoot);
  if (!configResult.ok) {
    throw paseoConfigParseError(configResult);
  }
  const scriptConfigs = getScriptConfigs(configResult.config);
  const config = scriptConfigs.get(scriptName);
  if (!config) {
    throw new Error(`Script '${scriptName}' is not configured in paseo.json`);
  }

  const serviceScript = isServiceScript(config);
  const scriptType = serviceScript ? "service" : "script";
  let hostname: string | null = null;
  let port: number | null = null;
  let runtimeRegistered = false;
  let routeRegistered = false;
  let disposeLifecycleListeners: (() => void) | null = null;

  try {
    if (runtimeStore.isRunning({ workspaceId, scriptName })) {
      throw new Error(`Script '${scriptName}' is already running`);
    }

    const existingRuntimeEntry = runtimeStore.get({ workspaceId, scriptName });
    let env: Record<string, string> | undefined;
    if (serviceScript) {
      const serviceSetup = await setupServiceScriptRoute({
        repoRoot,
        scriptConfigs,
        config,
        scriptName,
        projectSlug,
        branchName,
        workspaceId,
        daemonPort,
        daemonListenHost,
        serviceProxyPublicBaseUrl,
        existingRuntimeEntry,
        serviceProxy,
        servicePortAllocation: configResult.config?.worktree?.servicePorts ?? globalServicePorts,
      });
      hostname = serviceSetup.hostname;
      port = serviceSetup.port;
      env = serviceSetup.env;
      routeRegistered = true;
    }

    const { terminal, reusableTerminal } = await acquireWorkspaceScriptTerminal({
      serviceScript,
      existingRuntimeEntry,
      terminalManager,
      repoRoot,
      workspaceId,
      scriptName,
      env,
    });

    runtimeStore.set({
      workspaceId,
      scriptName,
      type: scriptType,
      lifecycle: "running",
      terminalId: terminal.id,
      exitCode: null,
    });
    runtimeRegistered = true;

    const stopRuntimeIfCurrent = (input: { exitCode: number | null; removeRoute: boolean }) => {
      const current = runtimeStore.get({ workspaceId, scriptName });
      if (current?.terminalId !== terminal.id || current.lifecycle !== "running") {
        return;
      }

      disposeLifecycleListeners?.();
      disposeLifecycleListeners = null;

      if (input.removeRoute && hostname) {
        serviceProxy.removeWorkspaceService({ workspaceId, scriptName });
      }
      runtimeStore.set({
        workspaceId,
        scriptName,
        type: scriptType,
        lifecycle: "stopped",
        terminalId: terminal.id,
        exitCode: input.exitCode,
      });
      onLifecycleChanged?.();
      logger?.info(
        {
          scriptName,
          hostname,
          exitCode: input.exitCode,
          terminalId: terminal.id,
        },
        "Stopped worktree script",
      );
    };

    const unsubscribeExit = terminal.onExit((info) => {
      stopRuntimeIfCurrent({
        exitCode: info.exitCode,
        removeRoute: true,
      });
    });

    let unsubscribeCommandFinished: (() => void) | null = null;
    if (!serviceScript) {
      unsubscribeCommandFinished = terminal.onCommandFinished((info) => {
        stopRuntimeIfCurrent({ exitCode: info.exitCode, removeRoute: false });
      });
    }
    disposeLifecycleListeners = () => {
      unsubscribeExit();
      unsubscribeCommandFinished?.();
    };

    if (!reusableTerminal) {
      await waitForTerminalBootstrapReadiness(terminal);
    }
    terminal.send({ type: "input", data: `${config.command}\r` });

    logger?.info(
      {
        scriptName,
        hostname,
        port,
        terminalId: terminal.id,
        type: scriptType,
      },
      serviceScript
        ? `Registered script proxy: ${hostname} -> 127.0.0.1:${port}`
        : "Started workspace script",
    );

    onLifecycleChanged?.();
    return {
      scriptName,
      hostname,
      port,
      terminalId: terminal.id,
    };
  } catch (error) {
    disposeLifecycleListeners?.();
    if (routeRegistered && hostname) {
      serviceProxy.removeServiceRoutesByHostnames([hostname]);
    }
    if (runtimeRegistered) {
      runtimeStore.remove({ workspaceId, scriptName });
    }
    logger?.error(
      {
        err: error,
        scriptName,
        repoRoot,
        branchName,
        hostname,
        port,
        command: config.command,
      },
      "Failed to spawn worktree script",
    );
    throw error;
  }
}

export function teardownWorktreeScripts(options: {
  hostnames: string[];
  serviceProxy: Pick<ServiceProxySubsystem, "removeServiceRoutesByHostnames">;
  logger: Logger;
}): void {
  const { hostnames, serviceProxy, logger } = options;
  serviceProxy.removeServiceRoutesByHostnames(hostnames);
  for (const hostname of hostnames) {
    logger.info({ hostname }, "Removed script proxy route");
  }
}
