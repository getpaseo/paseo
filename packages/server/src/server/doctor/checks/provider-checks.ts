import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DoctorCheckResult } from "../types.js";

const execFileAsync = promisify(execFile);

interface ProviderDef {
  name: string;
  command: string;
  label: string;
}

const PROVIDERS: ProviderDef[] = [
  { name: "claude", command: "claude", label: "Claude CLI" },
  { name: "codex", command: "codex", label: "Codex CLI" },
  { name: "opencode", command: "opencode", label: "OpenCode CLI" },
];

const EXEC_TIMEOUT_MS = 5000;

async function whichCommand(command: string): Promise<string | null> {
  const whichBin = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(whichBin, [command], { encoding: "utf8", timeout: EXEC_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], { encoding: "utf8", timeout: EXEC_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function checkBinary(provider: ProviderDef, binaryPath: string | null): DoctorCheckResult {
  if (binaryPath) {
    return {
      id: `provider.${provider.name}.binary`,
      label: provider.label,
      status: "ok",
      detail: binaryPath,
    };
  }
  return {
    id: `provider.${provider.name}.binary`,
    label: provider.label,
    status: "error",
    detail: "Not found in PATH",
  };
}

async function checkVersion(provider: ProviderDef, binaryPath: string | null): Promise<DoctorCheckResult> {
  if (!binaryPath) {
    return {
      id: `provider.${provider.name}.version`,
      label: `${provider.label} version`,
      status: "error",
      detail: "Binary not found",
    };
  }

  const version = await getVersion(binaryPath);
  if (version) {
    return {
      id: `provider.${provider.name}.version`,
      label: `${provider.label} version`,
      status: "ok",
      detail: version,
    };
  }

  return {
    id: `provider.${provider.name}.version`,
    label: `${provider.label} version`,
    status: "warn",
    detail: "Installed but version could not be parsed",
  };
}

async function checkProvider(provider: ProviderDef): Promise<DoctorCheckResult[]> {
  const binaryPath = await whichCommand(provider.command);
  return [checkBinary(provider, binaryPath), await checkVersion(provider, binaryPath)];
}

export async function runProviderChecks(): Promise<DoctorCheckResult[]> {
  const perProvider = await Promise.all(PROVIDERS.map(checkProvider));
  return perProvider.flat();
}
