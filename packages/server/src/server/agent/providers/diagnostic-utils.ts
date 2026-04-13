import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { execCommand } from "../../../utils/spawn.js";

type DiagnosticEntry = {
  label: string;
  value: string;
};

export function formatProviderDiagnostic(providerName: string, entries: DiagnosticEntry[]): string {
  return [providerName, ...entries.map((entry) => `  ${entry.label}: ${entry.value}`)].join("\n");
}

export function formatProviderDiagnosticError(providerName: string, error: unknown): string {
  return formatProviderDiagnostic(providerName, [
    {
      label: "Error",
      value: error instanceof Error ? error.message : String(error),
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

export function toDiagnosticErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "Unknown error";
}

export async function resolveBinaryVersion(binaryPath: string): Promise<string> {
  try {
    const { stdout } = await execCommand(binaryPath, ["--version"], { timeout: 5_000 });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
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
