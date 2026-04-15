/**
 * CLI Connections Service — detects installed CLI coding agents on the host.
 * Ported from emdash's ConnectionsService for the hubcode daemon.
 *
 * Runs `which <command>` + `<command> --version` for each detectable provider
 * and caches results so repeat calls are fast.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildCliAgentArgs as buildSharedCliAgentArgs,
  listDetectableCliProviders,
  listCliProviders,
  type CliProviderDefinition,
  type CliProviderId,
  type CliProviderOverrides,
} from "../shared/cli-provider-registry.js";
import type { CliAgentStatusEntry } from "../shared/messages.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 4_000;

interface CachedStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  lastChecked: number;
}

const statusCache = new Map<string, CachedStatus>();

/** Maximum cache age before a non-refresh call still returns cached (5 min). */
const CACHE_TTL_MS = 5 * 60 * 1000;

function isCacheValid(cached: CachedStatus): boolean {
  return Date.now() - cached.lastChecked < CACHE_TTL_MS;
}

function extractVersion(output: string): string | null {
  if (!output) return null;
  const match = output.match(/\d+\.\d+(\.\d+)?/);
  return match ? match[0] : null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  const resolver = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(resolver, [command], {
      timeout: 3_000,
      encoding: "utf8",
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

async function runVersionCheck(
  command: string,
  versionArgs: string[],
  timeoutMs: number,
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  version: string | null;
  resolvedPath: string | null;
}> {
  const resolvedPath = await resolveCommandPath(command);

  try {
    const { stdout, stderr } = await execFileAsync(command, versionArgs, {
      timeout: timeoutMs,
      encoding: "utf8",
      env: { ...process.env, TERM: "dumb" },
    });
    const version = extractVersion(stdout) || extractVersion(stderr);
    return { success: true, stdout, stderr, version, resolvedPath };
  } catch (error: any) {
    // If we at least resolved the path, the binary exists even if it errored
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const version = extractVersion(stdout) || extractVersion(stderr);
    return { success: false, stdout, stderr, version, resolvedPath };
  }
}

async function checkProvider(def: CliProviderDefinition): Promise<CliAgentStatusEntry> {
  const commands = def.commands ?? [];
  const versionArgs = def.versionArgs ?? ["--version"];

  for (const command of commands) {
    const result = await runVersionCheck(command, versionArgs, DEFAULT_TIMEOUT_MS);

    const isInstalled = result.success || result.resolvedPath !== null;

    statusCache.set(def.id, {
      installed: isInstalled,
      path: result.resolvedPath,
      version: result.version,
      lastChecked: Date.now(),
    });

    return {
      id: def.id,
      name: def.name,
      status: isInstalled ? "connected" : "missing",
      version: result.version,
      path: result.resolvedPath,
      docUrl: def.docUrl ?? null,
      installCommand: def.installCommand ?? null,
      cli: def.cli ?? null,
    };
  }

  // No commands to check (non-detectable but in registry)
  return {
    id: def.id,
    name: def.name,
    status: "missing",
    version: null,
    path: null,
    docUrl: def.docUrl ?? null,
    installCommand: def.installCommand ?? null,
    cli: def.cli ?? null,
  };
}

/**
 * Detect all CLI agents.
 * Returns all providers from the registry with their detected status.
 */
export async function detectCliAgents(
  options: { refresh?: boolean; overrides?: CliProviderOverrides | null } = {},
): Promise<CliAgentStatusEntry[]> {
  const detectable = listDetectableCliProviders(options.overrides);
  const allProviders = listCliProviders({ overrides: options.overrides });
  const { refresh = false } = options;

  const results: CliAgentStatusEntry[] = [];

  // Check detectable providers in parallel
  const checks = detectable.map(async (def) => {
    // Use cache if valid and not refreshing
    if (!refresh) {
      const cached = statusCache.get(def.id);
      if (cached && isCacheValid(cached)) {
        return {
          id: def.id,
          name: def.name,
          status: (cached.installed ? "connected" : "missing") as "connected" | "missing",
          version: cached.version,
          path: cached.path,
          docUrl: def.docUrl ?? null,
          installCommand: def.installCommand ?? null,
          cli: def.cli ?? null,
        };
      }
    }
    return checkProvider(def);
  });

  const detectedResults = await Promise.all(checks);
  results.push(...detectedResults);

  // Add non-detectable providers as "missing" (e.g. goose with detectable: false)
  const nonDetectable = allProviders.filter((p) => p.detectable === false || !p.commands?.length);
  for (const def of nonDetectable) {
    const cached = statusCache.get(def.id);
    results.push({
      id: def.id,
      name: def.name,
      status: cached?.installed ? "connected" : "missing",
      version: cached?.version ?? null,
      path: cached?.path ?? null,
      docUrl: def.docUrl ?? null,
      installCommand: def.installCommand ?? null,
      cli: def.cli ?? null,
    });
  }

  return results;
}

/**
 * Build the CLI args for launching a provider in a terminal.
 * Mirrors emdash's buildProviderCliArgs() logic.
 */
export function buildCliAgentArgs(options: {
  providerId: CliProviderId;
  autoApprove?: boolean;
  initialPrompt?: string;
  resume?: boolean;
  extraArgs?: string[];
}): string[] {
  return buildSharedCliAgentArgs(options);
}
