import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../server/private-files.js";

export interface AgentHookEventDefinition {
  event: string;
}

export type AgentHookActivityState = "running" | "idle" | "needs-input";

export interface AgentHookActivityInput {
  isTTY?: boolean;
  read(): Promise<string | null>;
}

export interface AgentHookProvider<TConfig = unknown> {
  id: string;
  events: AgentHookEventDefinition[];
  resolveActivity(input: {
    event: string;
    input: AgentHookActivityInput;
  }): Promise<AgentHookActivityState | null>;
  install: AgentHookInstallStrategy<TConfig>;
}

export type AgentHookInstallStrategy<TConfig> =
  | AgentHookConfigFileInstallStrategy<TConfig>
  | AgentHookPluginFileInstallStrategy;

interface AgentHookInstallStrategyBase {
  kind: "config-file" | "plugin-file";
  configDir: string;
  configDirBase?: "home" | "xdg-config";
  configFile: string;
  configDirEnvOverride?: string;
  hookMarker: string;
}

export interface AgentHookConfigFileInstallStrategy<TConfig> extends AgentHookInstallStrategyBase {
  kind: "config-file";
  format: AgentHookConfigFormat<TConfig>;
}

export interface AgentHookPluginFileInstallStrategy extends AgentHookInstallStrategyBase {
  kind: "plugin-file";
  source: string;
}

export interface AgentHookConfigFormat<TConfig> {
  empty(): TConfig;
  parse(raw: string): TConfig;
  stringify(config: TConfig): string;
  install(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  uninstall(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  isInstalled(config: TConfig, provider: AgentHookProvider<TConfig>): boolean;
}

export interface AgentHookInstallOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configDir?: string;
}

export interface AgentHookInstallLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface AgentHookInstallResult {
  configPath: string;
  changed: boolean;
}

export function installAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return installAgentHookPluginFile(provider.install, options);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(provider, options, (config) => format.install(config, provider));
}

export function uninstallAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return uninstallAgentHookPluginFile(provider.install, options);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(provider, options, (config) => format.uninstall(config, provider));
}

export function agentHooksAreInstalled<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): boolean {
  const configPath = resolveAgentHookConfigPath(provider, options);
  if (!existsSync(configPath)) {
    return false;
  }
  if (provider.install.kind === "plugin-file") {
    const currentRaw = readFileSync(configPath, "utf8");
    return normalizeRawConfig(currentRaw) === normalizeRawConfig(provider.install.source);
  }

  const config = provider.install.format.parse(readFileSync(configPath, "utf8"));
  return provider.install.format.isInstalled(config, provider);
}

export function resolveAgentHookConfigPath<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): string {
  return resolveAgentHookInstallPath(provider.install, options);
}

function resolveAgentHookInstallPath<TConfig>(
  install: AgentHookInstallStrategy<TConfig>,
  options: AgentHookInstallOptions,
): string {
  const configDir =
    options.configDir ??
    resolveConfiguredDirectory({
      install,
      env: options.env ?? process.env,
      homeDir: options.homeDir ?? homedir(),
    });
  return path.join(configDir, install.configFile);
}

export function buildAgentHookShellCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookCommand = `"\${PASEO_HOOK_CLI:-paseo}" hooks ${shellToken(provider.id)} ${shellToken(event.event)}`;
  return `[ -n "$PASEO_TERMINAL_ID" ] && ${hookCommand}`;
}

export function buildAgentHookWindowsCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookArgs = `hooks ${windowsToken(provider.id)} ${windowsToken(event.event)}`;
  return `if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" ${hookArgs}) else (paseo ${hookArgs}))`;
}

function installAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const nextRaw = normalizeRawConfig(install.source);

  if (currentRaw === null || normalizeRawConfig(currentRaw) !== nextRaw) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

function uninstallAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  if (!existsSync(configPath)) {
    return { configPath, changed: false };
  }

  rmSync(configPath, { force: true });
  return { configPath, changed: true };
}

function updateAgentHookConfig<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions,
  update: (config: TConfig) => TConfig,
): AgentHookInstallResult {
  const install = provider.install;
  if (install.kind !== "config-file") {
    throw new Error(`Provider ${provider.id} does not use config-file hooks`);
  }
  const configPath = resolveAgentHookConfigPath(provider, options);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const currentConfig =
    currentRaw === null ? install.format.empty() : install.format.parse(currentRaw);
  const nextConfig = update(currentConfig);
  const nextRaw = install.format.stringify(nextConfig);

  if (currentRaw === null || nextRaw !== normalizeRawConfig(currentRaw)) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

function resolveConfiguredDirectory<TConfig>(input: {
  install: AgentHookInstallStrategy<TConfig>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const overrideName = input.install.configDirEnvOverride;
  const override = overrideName ? input.env[overrideName] : undefined;
  if (override) {
    return override;
  }

  if (input.install.configDirBase === "xdg-config") {
    return path.join(resolveXdgConfigHome(input), input.install.configDir);
  }

  return path.join(input.homeDir, input.install.configDir);
}

function resolveXdgConfigHome(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.XDG_CONFIG_HOME) {
    return input.env.XDG_CONFIG_HOME;
  }

  return path.join(input.homeDir, ".config");
}

function normalizeRawConfig(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
