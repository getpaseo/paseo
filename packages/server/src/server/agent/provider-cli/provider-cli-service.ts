import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Logger } from "pino";
import type {
  ProviderCliAuthState,
  ProviderCliStatus,
  ProviderCliUpdateState,
} from "@getpaseo/protocol/provider-cli/rpc-schemas";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../../utils/spawn.js";
import { createProviderEnv, createProviderEnvSpec } from "../provider-launch-config.js";
import {
  PROVIDER_CLI_DEFINITIONS,
  findProviderCliDefinition,
  type ProviderCliCommandResult,
  type ProviderCliDefinition,
} from "./provider-cli-definitions.js";
import { ProviderCliLoginProcess } from "./provider-cli-login.js";
import { isCliUpdateAvailable, parseCliVersion } from "./provider-cli-version.js";

const PROBE_TTL_MS = 60_000;
const LATEST_VERSION_TTL_MS = 60 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_AUTO_UPDATE_INITIAL_DELAY_MS = 2 * 60_000;
const DEFAULT_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

export interface ProviderCliOverride {
  command?: string[];
  env?: Record<string, string>;
}

export interface ProviderCliServiceOptions {
  logger: Logger;
  /** Live provider config, so a custom command or env applies without a restart. */
  getProviderOverride(provider: string): ProviderCliOverride | undefined;
  /** True while an agent is mid-turn on this provider; auto-update waits for it. */
  isProviderBusy(provider: string): boolean;
  /** Called after an update or sign-in so the provider catalogue is re-probed. */
  onProviderChanged(provider: string): void;
  autoUpdate: boolean;
  fetchLatestVersion?: (npmPackage: string) => Promise<string | null>;
  autoUpdateInitialDelayMs?: number;
  autoUpdateIntervalMs?: number;
}

interface CommandSpec {
  command: string;
  args: string[];
}

interface ProviderCliProbe {
  at: number;
  managedExternally: boolean;
  resolvedPath: string | null;
  version: string | null;
  updateCommand: CommandSpec | null;
  auth: ProviderCliAuthState;
}

interface ProviderCliEntry {
  definition: ProviderCliDefinition;
  probe: ProviderCliProbe | null;
  probing: Promise<ProviderCliProbe> | null;
  update: ProviderCliUpdateState;
  login: ProviderCliLoginProcess | null;
}

const IDLE_UPDATE: ProviderCliUpdateState = {
  supported: false,
  status: "idle",
  error: null,
  finishedAt: null,
};

export async function fetchNpmLatestVersion(npmPackage: string): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) return null;
  const version = (body as Record<string, unknown>)["version"];
  return typeof version === "string" ? version : null;
}

async function runCommand(
  spec: CommandSpec,
  options: { env?: Record<string, string>; timeout: number },
): Promise<ProviderCliCommandResult> {
  try {
    const { stdout, stderr } = await execCommand(spec.command, spec.args, {
      ...createProviderEnvSpec({ runtimeSettings: { env: options.env } }),
      timeout: options.timeout,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code !== "number") throw error;
    return {
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      exitCode: failure.code,
    };
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUpdating(entry: ProviderCliEntry): boolean {
  return entry.update.status === "running";
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

/**
 * Keeps the built-in provider CLIs current and signed in. The agent runtime launches these same
 * binaries, so an update here is what the next agent session runs.
 */
export class ProviderCliService {
  private readonly entries = new Map<string, ProviderCliEntry>();
  private readonly latestVersions = new Map<string, { at: number; version: string | null }>();
  private readonly fetchLatestVersion: (npmPackage: string) => Promise<string | null>;
  private autoUpdate: boolean;
  private autoUpdateTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: ProviderCliServiceOptions) {
    this.fetchLatestVersion = options.fetchLatestVersion ?? fetchNpmLatestVersion;
    for (const definition of PROVIDER_CLI_DEFINITIONS) {
      this.entries.set(definition.provider, {
        definition,
        probe: null,
        probing: null,
        update: IDLE_UPDATE,
        login: null,
      });
    }
    this.autoUpdate = options.autoUpdate;
    if (this.autoUpdate) {
      this.scheduleAutoUpdate(
        options.autoUpdateInitialDelayMs ?? DEFAULT_AUTO_UPDATE_INITIAL_DELAY_MS,
      );
    }
  }

  async listStatus(options: { refresh?: boolean } = {}): Promise<ProviderCliStatus[]> {
    return Promise.all(
      Array.from(this.entries.values(), (entry) => this.readStatus(entry, options.refresh)),
    );
  }

  /** Resolves once the update has started; progress is reported through `listStatus`. */
  async startUpdate(provider: string): Promise<void> {
    const entry = this.requireEntry(provider);
    if (isUpdating(entry)) return;
    const updateCommand = (await this.ensureProbe(entry)).updateCommand;
    // Another request may have started the update while this one probed.
    if (isUpdating(entry)) return;
    if (!updateCommand) {
      throw new Error(`Paseo cannot update ${provider} on this host`);
    }
    void this.runUpdate(entry, updateCommand);
  }

  async startLogin(provider: string): Promise<void> {
    const entry = this.requireEntry(provider);
    if (entry.login?.isRunning) return;
    const probe = await this.ensureProbe(entry);
    if (entry.login?.isRunning) return;
    const loginArgs = entry.definition.loginArgs;
    const resolvedPath = probe.resolvedPath;
    if (!loginArgs || !resolvedPath || probe.managedExternally) {
      throw new Error(`Paseo cannot sign in to ${provider} on this host`);
    }
    const override = this.options.getProviderOverride(provider);
    entry.login = new ProviderCliLoginProcess({
      command: resolvedPath,
      args: loginArgs,
      env: createProviderEnv({ runtimeSettings: { env: override?.env } }),
      timeoutMs: LOGIN_TIMEOUT_MS,
      onExit: (status) => {
        this.options.logger.info({ provider, status }, "Provider sign-in finished");
        if (entry.probe) entry.probe = { ...entry.probe, at: 0 };
        if (status === "succeeded") this.options.onProviderChanged(provider);
      },
    });
  }

  sendLoginInput(provider: string, text: string): void {
    const login = this.requireEntry(provider).login;
    if (!login) throw new Error("No sign-in is running");
    login.write(text);
  }

  cancelLogin(provider: string): void {
    this.requireEntry(provider).login?.cancel();
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    if (this.autoUpdate === enabled) return;
    this.autoUpdate = enabled;
    this.clearAutoUpdateTimer();
    if (enabled) {
      this.scheduleAutoUpdate(
        this.options.autoUpdateInitialDelayMs ?? DEFAULT_AUTO_UPDATE_INITIAL_DELAY_MS,
      );
    }
  }

  close(): void {
    this.closed = true;
    this.clearAutoUpdateTimer();
    for (const entry of this.entries.values()) {
      entry.login?.cancel();
    }
  }

  private requireEntry(provider: string): ProviderCliEntry {
    const entry = this.entries.get(provider);
    if (!entry || !findProviderCliDefinition(provider)) {
      throw new Error(`Paseo does not manage the ${provider} CLI`);
    }
    return entry;
  }

  private async readStatus(entry: ProviderCliEntry, refresh?: boolean): Promise<ProviderCliStatus> {
    const [probe, latestVersion] = await Promise.all([
      this.ensureProbe(entry, refresh),
      this.readLatestVersion(entry.definition.npmPackage, refresh),
    ]);
    return {
      provider: entry.definition.provider,
      installed: probe.managedExternally || probe.resolvedPath !== null,
      version: probe.version,
      latestVersion,
      updateAvailable: isCliUpdateAvailable(probe.version, latestVersion),
      managedExternally: probe.managedExternally,
      update: { ...entry.update, supported: probe.updateCommand !== null },
      auth: probe.auth,
      login: entry.login?.snapshot() ?? null,
    };
  }

  private ensureProbe(entry: ProviderCliEntry, refresh?: boolean): Promise<ProviderCliProbe> {
    if (entry.probing) return entry.probing;
    if (!refresh && entry.probe && Date.now() - entry.probe.at < PROBE_TTL_MS) {
      return Promise.resolve(entry.probe);
    }
    entry.probing = this.probe(entry.definition)
      .then((probe) => {
        entry.probe = probe;
        return probe;
      })
      .finally(() => {
        entry.probing = null;
      });
    return entry.probing;
  }

  private async probe(definition: ProviderCliDefinition): Promise<ProviderCliProbe> {
    const override = this.options.getProviderOverride(definition.provider);
    const unsupportedAuth: ProviderCliAuthState = {
      supported: false,
      status: "unknown",
      account: null,
    };
    if (override?.command) {
      return {
        at: Date.now(),
        managedExternally: true,
        resolvedPath: null,
        version: null,
        updateCommand: null,
        auth: unsupportedAuth,
      };
    }

    const resolvedPath = await findExecutable(definition.binary, { env: override?.env });
    if (!resolvedPath) {
      return {
        at: Date.now(),
        managedExternally: false,
        resolvedPath: null,
        version: null,
        updateCommand: null,
        auth: unsupportedAuth,
      };
    }

    const [version, updateCommand, auth] = await Promise.all([
      this.probeVersion(resolvedPath, override?.env),
      this.resolveUpdateCommand(definition, resolvedPath),
      this.probeAuth(definition, resolvedPath, override?.env),
    ]);
    return { at: Date.now(), managedExternally: false, resolvedPath, version, updateCommand, auth };
  }

  private async probeVersion(
    resolvedPath: string,
    env: Record<string, string> | undefined,
  ): Promise<string | null> {
    try {
      const result = await runCommand(
        { command: resolvedPath, args: ["--version"] },
        { env, timeout: VERSION_TIMEOUT_MS },
      );
      return parseCliVersion(`${result.stdout}\n${result.stderr}`);
    } catch (error) {
      this.options.logger.debug({ err: error, resolvedPath }, "Provider CLI version probe failed");
      return null;
    }
  }

  private async probeAuth(
    definition: ProviderCliDefinition,
    resolvedPath: string,
    env: Record<string, string> | undefined,
  ): Promise<ProviderCliAuthState> {
    const probe = definition.authProbe;
    if (!probe) return { supported: false, status: "unknown", account: null };
    try {
      const result = await runCommand(
        { command: resolvedPath, args: probe.args },
        { env, timeout: AUTH_TIMEOUT_MS },
      );
      return { supported: definition.loginArgs !== null, ...probe.parse(result) };
    } catch (error) {
      this.options.logger.debug(
        { err: error, provider: definition.provider },
        "Provider CLI auth probe failed",
      );
      return { supported: definition.loginArgs !== null, status: "unknown", account: null };
    }
  }

  /**
   * npm installs update through the npm that owns them, so the global package moves instead of
   * the CLI writing over files npm tracks. Anything else uses the CLI's own updater.
   */
  private async resolveUpdateCommand(
    definition: ProviderCliDefinition,
    resolvedPath: string,
  ): Promise<CommandSpec | null> {
    const target = await realpath(resolvedPath).catch(() => resolvedPath);
    if (target.split(sep).includes("node_modules")) {
      const siblingNpm = join(
        dirname(resolvedPath),
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      const npm = (await isExecutable(siblingNpm)) ? siblingNpm : await findExecutable("npm");
      if (npm) {
        return { command: npm, args: ["install", "-g", `${definition.npmPackage}@latest`] };
      }
    }
    if (definition.selfUpdateArgs) {
      return { command: resolvedPath, args: definition.selfUpdateArgs };
    }
    return null;
  }

  private async readLatestVersion(npmPackage: string, refresh?: boolean): Promise<string | null> {
    const cached = this.latestVersions.get(npmPackage);
    if (!refresh && cached && Date.now() - cached.at < LATEST_VERSION_TTL_MS) {
      return cached.version;
    }
    try {
      const version = await this.fetchLatestVersion(npmPackage);
      this.latestVersions.set(npmPackage, { at: Date.now(), version });
      return version;
    } catch (error) {
      this.options.logger.debug({ err: error, npmPackage }, "Latest provider CLI lookup failed");
      return cached?.version ?? null;
    }
  }

  private async runUpdate(entry: ProviderCliEntry, updateCommand: CommandSpec): Promise<void> {
    const provider = entry.definition.provider;
    entry.update = { ...entry.update, status: "running", error: null };
    this.options.logger.info({ provider, command: updateCommand.command }, "Updating provider CLI");
    let error: string | null = null;
    try {
      const result = await runCommand(updateCommand, {
        env: this.options.getProviderOverride(provider)?.env,
        timeout: UPDATE_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        error =
          lastLines(result.stderr || result.stdout, 6) ||
          `Update exited with code ${result.exitCode}`;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    entry.update = {
      supported: true,
      status: error ? "failed" : "succeeded",
      error,
      finishedAt: new Date().toISOString(),
    };
    if (error) {
      this.options.logger.warn({ provider, error }, "Provider CLI update failed");
    }
    await this.ensureProbe(entry, true).catch(() => undefined);
    this.options.onProviderChanged(provider);
  }

  private scheduleAutoUpdate(delayMs: number): void {
    if (this.closed || !this.autoUpdate) return;
    this.autoUpdateTimer = setTimeout(() => {
      this.autoUpdateTimer = null;
      void this.runAutoUpdate().finally(() =>
        this.scheduleAutoUpdate(
          this.options.autoUpdateIntervalMs ?? DEFAULT_AUTO_UPDATE_INTERVAL_MS,
        ),
      );
    }, delayMs);
    this.autoUpdateTimer.unref();
  }

  private clearAutoUpdateTimer(): void {
    if (this.autoUpdateTimer) clearTimeout(this.autoUpdateTimer);
    this.autoUpdateTimer = null;
  }

  private async runAutoUpdate(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (this.closed || !this.autoUpdate) return;
      const provider = entry.definition.provider;
      try {
        const status = await this.readStatus(entry, true);
        const updateCommand = entry.probe?.updateCommand;
        if (!status.updateAvailable || !updateCommand || entry.update.status === "running") {
          continue;
        }
        if (this.options.isProviderBusy(provider)) {
          this.options.logger.info({ provider }, "Deferring provider CLI update while agents run");
          continue;
        }
        await this.runUpdate(entry, updateCommand);
      } catch (error) {
        this.options.logger.warn({ err: error, provider }, "Automatic provider CLI update failed");
      }
    }
  }
}
