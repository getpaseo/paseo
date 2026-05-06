import type { Logger } from "pino";
import type {
  ScriptStatusUpdateMessage,
  SessionOutboundMessage,
  WorkspaceScriptPayload,
} from "../shared/messages.js";
import type { PaseoConfig } from "../utils/paseo-config-schema.js";
import { buildScriptHostname } from "../utils/script-hostname.js";
import { getScriptConfigs, isServiceScript, readPaseoConfig } from "../utils/worktree.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import type { ScriptHealthEntry, ScriptHealthState } from "./script-health-monitor.js";
import type { ScriptRouteStore } from "./script-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

interface SessionEmitter {
  emit(message: SessionOutboundMessage): void;
}

interface BuildWorkspaceScriptPayloadsOptions {
  workspaceId: string;
  workspaceDirectory: string;
  paseoConfig: PaseoConfig | null;
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null;
  gitMetadata?: {
    projectSlug: string;
    currentBranch: string | null;
  };
  resolveHealth?: (hostname: string) => ScriptHealthState | null;
}

export function readPaseoConfigForProjection(
  workspaceDirectory: string,
  logger: Logger,
): PaseoConfig | null {
  const result = readPaseoConfig(workspaceDirectory);
  if (result.ok) {
    return result.config;
  }
  logger.warn(
    { configPath: result.configPath, workspaceDirectory, err: result.error },
    "Failed to parse paseo.json; treating workspace as having no scripts",
  );
  return null;
}

function resolveDaemonPort(daemonPort: number | null | (() => number | null)): number | null {
  if (typeof daemonPort === "function") {
    return daemonPort();
  }
  return daemonPort;
}

function toServiceProxyUrl(hostname: string, daemonPort: number | null): string | null {
  if (daemonPort === null) {
    return null;
  }
  return `http://${hostname}:${daemonPort}`;
}

function toWireHealth(health: ScriptHealthState | null): WorkspaceScriptPayload["health"] {
  if (health === "pending" || health === null) {
    return null;
  }
  return health;
}

function sortPayloads(payloads: WorkspaceScriptPayload[]): WorkspaceScriptPayload[] {
  return payloads.sort((left, right) =>
    left.scriptName.localeCompare(right.scriptName, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

type RuntimeEntry = ReturnType<WorkspaceScriptRuntimeStore["listForWorkspace"]>[number];
type RouteEntry = ReturnType<ScriptRouteStore["listRoutesForWorkspace"]>[number];

interface BuildPayloadContext {
  projectSlug: string;
  branchName: string | null;
  daemonPort: number | null;
  resolveHealth?: (hostname: string) => ScriptHealthState | null;
}

function buildConfiguredScriptPayload(
  scriptName: string,
  config: ReturnType<typeof getScriptConfigs> extends Map<string, infer V> ? V : never,
  runtimeEntry: RuntimeEntry | null,
  routeEntry: RouteEntry | null,
  ctx: BuildPayloadContext,
): WorkspaceScriptPayload {
  const configIsService = isServiceScript(config);
  const type = configIsService ? "service" : "script";
  const configuredPort = configIsService ? (config.port ?? null) : null;
  const hostname =
    type === "service"
      ? (routeEntry?.hostname ??
        buildScriptHostname({
          projectSlug: ctx.projectSlug,
          branchName: ctx.branchName,
          scriptName,
        }))
      : scriptName;

  return {
    scriptName,
    type,
    hostname,
    port: type === "service" ? (routeEntry?.port ?? configuredPort) : null,
    proxyUrl: type === "service" ? toServiceProxyUrl(hostname, ctx.daemonPort) : null,
    lifecycle: runtimeEntry?.lifecycle ?? "stopped",
    health: type === "service" ? toWireHealth(ctx.resolveHealth?.(hostname) ?? null) : null,
    exitCode: runtimeEntry?.exitCode ?? null,
    terminalId: runtimeEntry?.terminalId ?? null,
  };
}

function buildOrphanRuntimePayload(
  runtimeEntry: RuntimeEntry,
  routeEntry: RouteEntry | null,
  ctx: BuildPayloadContext,
): WorkspaceScriptPayload {
  const type = runtimeEntry.type;
  const hostname =
    type === "service"
      ? (routeEntry?.hostname ??
        buildScriptHostname({
          projectSlug: ctx.projectSlug,
          branchName: ctx.branchName,
          scriptName: runtimeEntry.scriptName,
        }))
      : runtimeEntry.scriptName;
  return {
    scriptName: runtimeEntry.scriptName,
    type,
    hostname,
    port: type === "service" ? (routeEntry?.port ?? null) : null,
    proxyUrl: type === "service" ? toServiceProxyUrl(hostname, ctx.daemonPort) : null,
    lifecycle: runtimeEntry.lifecycle,
    health:
      type === "service" && routeEntry ? toWireHealth(ctx.resolveHealth?.(hostname) ?? null) : null,
    exitCode: runtimeEntry.exitCode,
    terminalId: runtimeEntry.terminalId,
  };
}

export function buildWorkspaceScriptPayloads(
  options: BuildWorkspaceScriptPayloadsOptions,
): WorkspaceScriptPayload[] {
  const workspaceId = options.workspaceId;
  const workspaceDirectory = options.workspaceDirectory;
  const projectSlug = options.gitMetadata?.projectSlug ?? deriveProjectSlug(workspaceDirectory);
  const branchName = options.gitMetadata?.currentBranch ?? null;
  const scriptConfigs = getScriptConfigs(options.paseoConfig);
  const runtimeEntries = new Map(
    options.runtimeStore
      .listForWorkspace(workspaceId)
      .map((entry) => [entry.scriptName, entry] as const),
  );
  const routesByScriptName = new Map(
    options.routeStore
      .listRoutesForWorkspace(workspaceId)
      .map((entry) => [entry.scriptName, entry] as const),
  );

  const ctx: BuildPayloadContext = {
    projectSlug,
    branchName,
    daemonPort: options.daemonPort,
    resolveHealth: options.resolveHealth,
  };

  const payloads: WorkspaceScriptPayload[] = [];

  for (const [scriptName, config] of scriptConfigs.entries()) {
    const runtimeEntry = runtimeEntries.get(scriptName) ?? null;
    const routeEntry = routesByScriptName.get(scriptName) ?? null;
    payloads.push(buildConfiguredScriptPayload(scriptName, config, runtimeEntry, routeEntry, ctx));
  }

  for (const runtimeEntry of runtimeEntries.values()) {
    if (scriptConfigs.has(runtimeEntry.scriptName) || runtimeEntry.lifecycle !== "running") {
      continue;
    }
    const routeEntry = routesByScriptName.get(runtimeEntry.scriptName) ?? null;
    payloads.push(buildOrphanRuntimePayload(runtimeEntry, routeEntry, ctx));
  }

  return sortPayloads(payloads);
}

function buildScriptStatusUpdateMessage(params: {
  workspaceId: string;
  scripts: WorkspaceScriptPayload[];
}): ScriptStatusUpdateMessage {
  return {
    type: "script_status_update",
    payload: {
      workspaceId: params.workspaceId,
      scripts: params.scripts,
    },
  };
}

export function createScriptStatusEmitter({
  sessions,
  routeStore,
  runtimeStore,
  daemonPort,
  resolveWorkspaceDirectory,
  logger,
}: {
  sessions: () => SessionEmitter[];
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null | (() => number | null);
  resolveWorkspaceDirectory: (workspaceId: string) => string | null | Promise<string | null>;
  logger: Logger;
}): (workspaceId: string, scripts: ScriptHealthEntry[]) => void {
  return (workspaceId, scripts) => {
    void (async () => {
      const workspaceDirectory = await resolveWorkspaceDirectory(workspaceId);
      if (!workspaceDirectory) {
        return;
      }

      const resolvedDaemonPort = resolveDaemonPort(daemonPort);
      const scriptHealthByHostname = new Map(
        scripts.map((script) => [script.hostname, script.health] as const),
      );

      const projected = buildWorkspaceScriptPayloads({
        workspaceId,
        workspaceDirectory,
        paseoConfig: readPaseoConfigForProjection(workspaceDirectory, logger),
        routeStore,
        runtimeStore,
        daemonPort: resolvedDaemonPort,
        resolveHealth: (hostname) => scriptHealthByHostname.get(hostname) ?? null,
      });

      const message = buildScriptStatusUpdateMessage({
        workspaceId,
        scripts: projected,
      });

      for (const session of sessions()) {
        session.emit(message);
      }
    })();
  };
}
