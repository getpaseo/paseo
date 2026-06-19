import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import {
  createProviderEnvSpec,
  type ProviderLaunchAvailability,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../provider-launch-config.js";
import { execCommand } from "../../../utils/spawn.js";

export interface DiagnosticEntry {
  label: string;
  value: string;
}

export function formatProviderDiagnostic(providerName: string, entries: DiagnosticEntry[]): string {
  return [providerName, ...entries.map((entry) => `  ${entry.label}: ${entry.value}`)].join("\n");
}

export function formatProviderDiagnosticError(providerName: string, error: unknown): string {
  return formatProviderDiagnostic(providerName, [
    {
      label: "Error",
      value: toDiagnosticErrorMessage(error),
    },
  ]);
}

export function formatAvailabilityStatus(available: boolean): string {
  return available ? "Available" : "Unavailable";
}

export function formatDiagnosticStatus(
  available: boolean,
  error?: { source: string; cause: unknown },
): string {
  if (error) {
    return `Error (${error.source} failed: ${toDiagnosticErrorMessage(error.cause)})`;
  }
  return formatAvailabilityStatus(available);
}

const DIAGNOSTIC_OUTPUT_CAP = 4096;

function truncateForDiagnostic(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= DIAGNOSTIC_OUTPUT_CAP) {
    return trimmed;
  }
  return `${trimmed.slice(0, DIAGNOSTIC_OUTPUT_CAP)}…(truncated)`;
}

function readStringProperty(error: Error, key: string): string | undefined {
  if (!(key in error)) return undefined;
  const value = (error as Error & Record<string, unknown>)[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readUnknownProperty(error: Error, key: string): unknown {
  if (!(key in error)) return undefined;
  return (error as Error & Record<string, unknown>)[key];
}

function pushIfNonEmpty(sections: string[], label: string, value: string | undefined): void {
  if (value && value.trim().length > 0) {
    sections.push(`${label}: ${value.trim()}`);
  }
}

function pushTruncatedIfNonEmpty(
  sections: string[],
  label: string,
  value: string | undefined,
): void {
  if (value && value.trim().length > 0) {
    sections.push(`${label}: ${truncateForDiagnostic(value)}`);
  }
}

function formatErrorDiagnostic(error: Error): string {
  const sections: string[] = [];
  if (error.message && error.message.trim().length > 0) {
    sections.push(error.message.trim());
  }
  pushIfNonEmpty(sections, "exit code", readStringProperty(error, "code"));
  pushIfNonEmpty(sections, "signal", readStringProperty(error, "signal"));
  pushTruncatedIfNonEmpty(sections, "stderr", readStringProperty(error, "stderr"));
  pushTruncatedIfNonEmpty(sections, "stdout", readStringProperty(error, "stdout"));
  const cause = readUnknownProperty(error, "cause");
  if (cause !== undefined && cause !== null) {
    const causeMessage = toDiagnosticErrorMessage(cause);
    if (causeMessage && causeMessage !== "Unknown error") {
      sections.push(`caused by: ${causeMessage}`);
    }
  }
  return sections.length > 0 ? sections.join("\n") : "Unknown error";
}

function formatNonErrorDiagnostic(error: unknown): string {
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}" && serialized !== '""') {
      return serialized;
    }
  } catch {
    // fall through to String() below
  }

  const stringified = String(error);
  if (stringified.length > 0 && stringified !== "[object Object]") {
    return stringified;
  }
  return "Unknown error";
}

export function toDiagnosticErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return formatErrorDiagnostic(error);
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : "Unknown error";
  }
  if (error === null || error === undefined) {
    return "Unknown error";
  }
  return formatNonErrorDiagnostic(error);
}

export async function resolveBinaryVersion(binaryPath: string): Promise<string> {
  try {
    const { stdout } = await execCommand(binaryPath, ["--version"], {
      ...createProviderEnvSpec(),
      timeout: 5_000,
    });
    return stdout.trim() || "unknown";
  } catch (error) {
    return `error: ${toDiagnosticErrorMessage(error)}`;
  }
}

export interface BinaryDiagnosticVersionCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface BinaryDiagnosticRowsOptions {
  binaryLabel?: string;
  versionCommand?: BinaryDiagnosticVersionCommand;
}

export interface CommandResolutionDiagnosticRowsOptions {
  knownBinaryNames: readonly string[];
}

const COMMAND_PROBE_TIMEOUT_MS = 3_000;
const COMMAND_PROBE_MAX_BUFFER = 32 * 1024;

function resolvePathValue(): string {
  return process.env["PATH"] ?? process.env["Path"] ?? "";
}

function resolveShellValue(): string {
  if (process.platform === "win32") {
    return process.env["ComSpec"] ?? "cmd.exe";
  }
  return process.env["SHELL"] ?? "/bin/sh";
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const candidate = await stat(filePath);
    if (!candidate.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function formatPathMatches(binaryNames: readonly string[]): Promise<string> {
  const searchableNames = binaryNames.filter(
    (binaryName) =>
      binaryName.trim().length > 0 && !binaryName.includes("/") && !binaryName.includes("\\"),
  );

  if (searchableNames.length === 0) {
    return "not checked";
  }

  const pathEntries = resolvePathValue().split(path.delimiter).filter(Boolean);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const directory of pathEntries) {
    for (const binaryName of searchableNames) {
      const candidate = path.join(directory, binaryName);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (await isExecutableFile(candidate)) {
        matches.push(candidate);
      }
    }
  }

  return matches.length > 0 ? matches.join("\n    ") : "none";
}

function shellToken(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCommandProbeOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  const trimmedStdout = truncateForDiagnostic(stdout);
  const trimmedStderr = truncateForDiagnostic(stderr);
  if (trimmedStdout.length > 0) {
    sections.push(trimmedStdout);
  }
  if (trimmedStderr.length > 0) {
    sections.push(`stderr: ${trimmedStderr}`);
  }
  return sections.length > 0 ? sections.join("\n") : "(no output)";
}

function formatCommandProbeError(error: unknown): string {
  if (error instanceof Error) {
    return toDiagnosticErrorMessage(error);
  }
  return toDiagnosticErrorMessage(error);
}

async function runCommandProbe(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execCommand(command, args, {
      timeout: COMMAND_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: COMMAND_PROBE_MAX_BUFFER,
    });
    return formatCommandProbeOutput(stdout, stderr);
  } catch (error) {
    return formatCommandProbeError(error);
  }
}

async function buildPosixCommandProbeRows(binaryName: string): Promise<DiagnosticEntry[]> {
  const shell = resolveShellValue();
  const typeCommand = `type -a ${shellToken(binaryName)}`;
  return [
    {
      label: `which -a ${binaryName}`,
      value: await runCommandProbe("/usr/bin/which", ["-a", binaryName]),
    },
    {
      label: `${path.basename(shell)} -lc type -a ${binaryName}`,
      value: await runCommandProbe(shell, ["-lc", typeCommand]),
    },
  ];
}

async function buildWindowsCommandProbeRows(binaryName: string): Promise<DiagnosticEntry[]> {
  const powershellCommand = [
    "$ErrorActionPreference = 'Continue';",
    `Get-Command -All ${JSON.stringify(binaryName)} |`,
    "Select-Object CommandType,Source,Name,Definition |",
    "Format-List",
  ].join(" ");

  return [
    {
      label: `where.exe ${binaryName}`,
      value: await runCommandProbe("where.exe", [binaryName]),
    },
    {
      label: `powershell Get-Command -All ${binaryName}`,
      value: await runCommandProbe("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        powershellCommand,
      ]),
    },
  ];
}

async function buildCommandProbeRows(binaryNames: readonly string[]): Promise<DiagnosticEntry[]> {
  const searchableNames = binaryNames.filter(
    (binaryName) =>
      binaryName.trim().length > 0 && !binaryName.includes("/") && !binaryName.includes("\\"),
  );
  if (searchableNames.length === 0) {
    return [];
  }

  const rows: DiagnosticEntry[] = [];
  for (const binaryName of searchableNames) {
    rows.push(
      ...(process.platform === "win32"
        ? await buildWindowsCommandProbeRows(binaryName)
        : await buildPosixCommandProbeRows(binaryName)),
    );
  }
  return rows;
}

export async function buildCommandResolutionDiagnosticRows(
  launch: ResolvedProviderLaunch,
  options: CommandResolutionDiagnosticRowsOptions,
): Promise<DiagnosticEntry[]> {
  return [
    {
      label: "Command source",
      value: launch.source,
    },
    {
      label: "Configured command",
      value: [launch.command, ...launch.args].join(" "),
    },
    {
      label: "Daemon PATH",
      value: resolvePathValue() || "(empty)",
    },
    {
      label: "Daemon shell",
      value: resolveShellValue(),
    },
    {
      label: "PATH matches",
      value: await formatPathMatches(options.knownBinaryNames),
    },
    ...(await buildCommandProbeRows(options.knownBinaryNames)),
  ];
}

async function resolveCommandVersion(invocation: BinaryDiagnosticVersionCommand): Promise<string> {
  try {
    const { stdout, stderr } = await execCommand(invocation.command, invocation.args, {
      ...createProviderEnvSpec({ runtimeSettings: { env: invocation.env } }),
      timeout: 5_000,
    });
    return stdout.trim() || stderr.trim() || "unknown";
  } catch (error) {
    return `error: ${toDiagnosticErrorMessage(error)}`;
  }
}

export async function buildBinaryDiagnosticRows(
  launch: ResolvedProviderLaunch,
  availability: ProviderLaunchAvailability,
  options: BinaryDiagnosticRowsOptions = {},
): Promise<DiagnosticEntry[]> {
  const defaultBinaryLabel = launch.source === "override" ? "Binary (override)" : "Binary";
  const binaryLabel = options.binaryLabel ?? defaultBinaryLabel;
  let version = "unknown";
  if (options.versionCommand && availability.available) {
    version = await resolveCommandVersion(options.versionCommand);
  } else if (availability.available) {
    version = await resolveCommandVersion({
      command: availability.resolvedPath ?? launch.command,
      args: [...launch.args, "--version"],
    });
  }
  return [
    {
      label: binaryLabel,
      value: launch.command,
    },
    {
      label: "Resolved path",
      value: availability.resolvedPath ?? "not found",
    },
    {
      label: "Version",
      value: version,
    },
  ];
}

export function formatConfiguredCommand(
  defaultArgv: readonly string[],
  runtimeSettings?: ProviderRuntimeSettings,
): string {
  const command = runtimeSettings?.command;
  if (!command || command.mode === "default") {
    return `${defaultArgv.join(" ")} (default)`;
  }

  if (command.mode === "append") {
    return [defaultArgv[0], ...(command.args ?? []), ...defaultArgv.slice(1)].join(" ");
  }

  return command.argv.join(" ");
}
