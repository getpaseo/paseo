import { createHash } from "node:crypto";
import type { WorkspaceScriptPayload, WorkspaceServicePayload } from "@getpaseo/protocol/messages";
import type { WorkspaceServiceRuntime } from "./workspace-service-runtime.js";
import type { PackageServiceSuggestion } from "./package-service-suggestions.js";
import {
  listConfiguredServiceOptions,
  type ConfiguredServiceOptions,
} from "./configured-service-options.js";

interface WorkspaceScriptsReader {
  list(workspaceId: string): Promise<WorkspaceScriptPayload[]>;
}

function stableId(
  source: WorkspaceServicePayload["source"],
  workspaceId: string,
  key: string,
): string {
  const digest = createHash("sha256")
    .update(`${source}\0${workspaceId}\0${key}`)
    .digest("hex")
    .slice(0, 16);
  return `wsvc_${digest}`;
}

function configuredLifecycle(script: WorkspaceScriptPayload): WorkspaceServicePayload["lifecycle"] {
  if (script.lifecycle === "running") {
    if (script.health === "healthy") return "healthy";
    if (script.health === "unhealthy") return "unhealthy";
    return "starting";
  }
  return script.exitCode === null ? "stopped" : "exited";
}

const lifecycleRank: Record<WorkspaceServicePayload["lifecycle"], number> = {
  healthy: 0,
  starting: 1,
  available: 2,
  unhealthy: 3,
  stopped: 4,
  exited: 5,
};

const sourceRank: Record<WorkspaceServicePayload["source"], number> = {
  configured: 0,
  terminal: 1,
  package: 2,
};

export class WorkspaceServiceInventory {
  constructor(
    private readonly options: {
      workspaceScripts: WorkspaceScriptsReader;
      runtime: WorkspaceServiceRuntime | null;
      resolveWorkspaceCwd: (workspaceId: string) => Promise<string | null>;
      listPackageSuggestions: (cwd: string) => Promise<PackageServiceSuggestion[]>;
      listConfiguredOptions?: (cwd: string) => Map<string, ConfiguredServiceOptions>;
      now?: () => Date;
    },
  ) {}

  async list(workspaceId: string): Promise<WorkspaceServicePayload[]> {
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const cwd = await this.options.resolveWorkspaceCwd(workspaceId);
    const configuredOptions = cwd
      ? (this.options.listConfiguredOptions ?? listConfiguredServiceOptions)(cwd)
      : new Map<string, ConfiguredServiceOptions>();
    const scripts = await this.options.workspaceScripts.list(workspaceId);
    const configured = scripts
      .filter((script) => script.type === "service")
      .map(
        (script): WorkspaceServicePayload => ({
          id: stableId("configured", workspaceId, script.scriptName),
          workspaceId,
          source: "configured",
          label: script.scriptName,
          lifecycle: configuredLifecycle(script),
          terminalId: script.terminalId ?? null,
          port: script.port,
          localUrl: script.localProxyUrl ?? script.proxyUrl ?? null,
          publicUrl: script.publicProxyUrl ?? null,
          command: null,
          openWhenHealthy: configuredOptions.get(script.scriptName)?.openWhenHealthy ?? false,
          observedAt: now,
        }),
      );
    const configuredPorts = new Set(configured.flatMap((service) => service.port ?? []));
    const terminal = (this.options.runtime?.listTerminalCandidates(workspaceId) ?? [])
      .filter((candidate) => !configuredPorts.has(candidate.port))
      .map(
        (candidate): WorkspaceServicePayload => ({
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          source: candidate.source,
          label: candidate.label,
          lifecycle: candidate.lifecycle,
          terminalId: candidate.terminalId,
          port: candidate.port,
          localUrl: candidate.localUrl,
          publicUrl: candidate.publicUrl,
          command: null,
          openWhenHealthy: false,
          observedAt: candidate.observedAt,
        }),
      );

    const configuredNames = new Set(configured.map((service) => service.label));
    const packageSuggestions = cwd ? await this.options.listPackageSuggestions(cwd) : [];
    const packages = packageSuggestions
      .filter((suggestion) => !configuredNames.has(suggestion.scriptName))
      .map(
        (suggestion): WorkspaceServicePayload => ({
          id: stableId("package", workspaceId, suggestion.command),
          workspaceId,
          source: "package",
          label: suggestion.scriptName,
          lifecycle: "available",
          terminalId: null,
          port: null,
          localUrl: null,
          publicUrl: null,
          command: suggestion.command,
          openWhenHealthy: false,
          observedAt: now,
        }),
      );

    return [...configured, ...terminal, ...packages].sort(
      (left, right) =>
        lifecycleRank[left.lifecycle] - lifecycleRank[right.lifecycle] ||
        sourceRank[left.source] - sourceRank[right.source] ||
        left.label.localeCompare(right.label),
    );
  }
}
