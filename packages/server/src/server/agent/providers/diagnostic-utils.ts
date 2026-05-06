import { createProviderEnvSpec, type ProviderRuntimeSettings } from "../provider-launch-config.js";
import { execCommand } from "../../../utils/spawn.js";

interface DiagnosticEntry {
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
