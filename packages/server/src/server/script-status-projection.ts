import type { Logger } from "pino";
import type {
  ScriptStatusUpdateMessage,
  SessionOutboundMessage,
  WorkspaceScriptPayload,
} from "@getpaseo/protocol/messages";
import type { PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import { getScriptConfigs, isServiceScript, readPaseoConfig } from "../utils/worktree.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import type { ScriptHealthEntry, ScriptHealthState } from "./script-health-monitor.js";
import type {
  ServiceProxySubsystem,
  ServiceProxyWorkspaceScriptProjection,
} from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

interface SessionEmitter {
  emit(message: SessionOutboundMessage): void;
}

interface BuildWorkspaceScriptPayloadsOptions {
  workspaceId: string;
  workspaceDirectory: string;
  paseoConfig: PaseoConfig | null;
  serviceProxy: ServiceProxySubsystem;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null;
  serviceProxyPublicBaseUrl?: string | null;
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
interface BuildPayloadContext {
  projectSlug: string;
  branchName: string | null;
  daemonPort: number | null;
  serviceProxyPublicBaseUrl?: string | null;
  serviceProxy: ServiceProxySubsystem;
  resolveHealth?: (hostname: string) => ScriptHealthState | null;
}

function projectWorkspaceServiceState(params: {
  workspaceId: string;
  scriptName: string;
  ctx: BuildPayloadContext;
}): ServiceProxyWorkspaceScriptProjection {
  return params.ctx.serviceProxy.projectWorkspaceServiceState({
    workspaceId: params.workspaceId,
    projectSlug: params.ctx.projectSlug,
    branchName: params.ctx.branchName,
    scriptName: params.scriptName,
    daemonPort: params.ctx.daemonPort,
    publicBaseUrl: params.ctx.serviceProxyPublicBaseUrl,
  });
}

function buildConfiguredPlainScriptPayload(
  scriptName: string,
  runtimeEntry: RuntimeEntry | null,
): WorkspaceScriptPayload {
  return {
    scriptName,
    type: "script",
    hostname: scriptName,
    port: null,
    proxyUrl: null,
    lifecycle: runtimeEntry?.lifecycle ?? "stopped",
    health: null,
    exitCode: runtimeEntry?.exitCode ?? null,
    terminalId: runtimeEntry?.terminalId ?? null,
  };
}

function buildConfiguredScriptPayload(
  scriptName: string,
  config: ReturnType<typeof getScriptConfigs> extends Map<string, infer V> ? V : never,
  runtimeEntry: RuntimeEntry | null,
  serviceState: ServiceProxyWorkspaceScriptProjection | null,
  ctx: BuildPayloadContext,
): WorkspaceScriptPayload {
  const configIsService = isServiceScript(config);
  if (!configIsService) {
    return buildConfiguredPlainScriptPayload(scriptName, runtimeEntry);
  }

  const type = "service";
  const configuredPort = config.port ?? null;
  const hostname = (
    serviceState ??
    ctx.serviceProxy.projectWorkspaceService({
      projectSlug: ctx.projectSlug,
      branchName: ctx.branchName,
      scriptName,
      daemonPort: ctx.daemonPort,
      publicBaseUrl: ctx.serviceProxyPublicBaseUrl,
    })
  ).hostname;

  const urls =
    serviceState ??
    ctx.serviceProxy.projectUrls({
      projectSlug: ctx.projectSlug,
      branchName: ctx.branchName,
      scriptName,
      daemonPort: ctx.daemonPort,
      publicBaseUrl: ctx.serviceProxyPublicBaseUrl,
    });

  return {
    scriptName,
    type,
    hostname,
    port: serviceState?.port ?? configuredPort,
    localProxyUrl: urls.localProxyUrl,
    publicProxyUrl: urls.publicProxyUrl,
    proxyUrl: urls.proxyUrl,
    lifecycle: runtimeEntry?.lifecycle ?? "stopped",
    health: toWireHealth(ctx.resolveHealth?.(hostname) ?? null),
    exitCode: runtimeEntry?.exitCode ?? null,
    terminalId: runtimeEntry?.terminalId ?? null,
  };
}

function buildOrphanRuntimePayload(
  runtimeEntry: RuntimeEntry,
  serviceState: ServiceProxyWorkspaceScriptProjection | null,
  ctx: BuildPayloadContext,
): WorkspaceScriptPayload {
  const type = runtimeEntry.type;
  const hostname =
    type === "service"
      ? (
          serviceState ??
          ctx.serviceProxy.projectWorkspaceService({
            projectSlug: ctx.projectSlug,
            branchName: ctx.branchName,
            scriptName: runtimeEntry.scriptName,
            daemonPort: ctx.daemonPort,
            publicBaseUrl: ctx.serviceProxyPublicBaseUrl,
          })
        ).hostname
      : runtimeEntry.scriptName;
  const urls =
    serviceState ??
    ctx.serviceProxy.projectUrls({
      projectSlug: ctx.projectSlug,
      branchName: ctx.branchName,
      scriptName: runtimeEntry.scriptName,
      daemonPort: ctx.daemonPort,
      publicBaseUrl: ctx.serviceProxyPublicBaseUrl,
    });

  return {
    scriptName: runtimeEntry.scriptName,
    type,
    hostname,
    port: type === "service" ? (serviceState?.port ?? null) : null,
    ...(type === "service"
      ? { localProxyUrl: urls.localProxyUrl, publicProxyUrl: urls.publicProxyUrl }
      : {}),
    proxyUrl: type === "service" ? urls.proxyUrl : null,
    lifecycle: runtimeEntry.lifecycle,
    health:
      type === "service" && serviceState?.port !== null
        ? toWireHealth(ctx.resolveHealth?.(hostname) ?? null)
        : null,
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
  const ctx: BuildPayloadContext = {
    projectSlug,
    branchName,
    daemonPort: options.daemonPort,
    serviceProxyPublicBaseUrl: options.serviceProxyPublicBaseUrl,
    serviceProxy: options.serviceProxy,
    resolveHealth: options.resolveHealth,
  };

  const payloads: WorkspaceScriptPayload[] = [];

  for (const [scriptName, config] of scriptConfigs.entries()) {
    const runtimeEntry = runtimeEntries.get(scriptName) ?? null;
    const serviceState = isServiceScript(config)
      ? projectWorkspaceServiceState({ workspaceId, scriptName, ctx })
      : null;
    payloads.push(
      buildConfiguredScriptPayload(scriptName, config, runtimeEntry, serviceState, ctx),
    );
  }

  for (const runtimeEntry of runtimeEntries.values()) {
    if (scriptConfigs.has(runtimeEntry.scriptName) || runtimeEntry.lifecycle !== "running") {
      continue;
    }
    const serviceState =
      runtimeEntry.type === "service"
        ? projectWorkspaceServiceState({ workspaceId, scriptName: runtimeEntry.scriptName, ctx })
        : null;
    payloads.push(buildOrphanRuntimePayload(runtimeEntry, serviceState, ctx));
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
  serviceProxy,
  runtimeStore,
  daemonPort,
  serviceProxyPublicBaseUrl,
  resolveWorkspaceDirectory,
  logger,
}: {
  sessions: () => SessionEmitter[];
  serviceProxy: ServiceProxySubsystem;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null | (() => number | null);
  serviceProxyPublicBaseUrl?: string | null;
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
        serviceProxy,
        runtimeStore,
        daemonPort: resolvedDaemonPort,
        serviceProxyPublicBaseUrl,
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
