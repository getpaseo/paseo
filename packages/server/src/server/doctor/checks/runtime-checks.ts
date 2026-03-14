import { resolveDaemonVersion } from "../../daemon-version.js";
import type { DoctorCheckResult } from "../types.js";

function checkNodeVersion(): DoctorCheckResult {
  return {
    id: "runtime.node",
    label: "Node.js",
    status: "ok",
    detail: process.version,
  };
}

function checkPaseoVersion(version?: string): DoctorCheckResult {
  const resolved = version ?? tryResolveDaemonVersion();
  if (resolved) {
    return {
      id: "runtime.paseo",
      label: "Paseo daemon",
      status: "ok",
      detail: resolved,
    };
  }
  return {
    id: "runtime.paseo",
    label: "Paseo daemon",
    status: "error",
    detail: "Version unknown",
  };
}

function tryResolveDaemonVersion(): string | null {
  try {
    return resolveDaemonVersion();
  } catch {
    return null;
  }
}

export async function runRuntimeChecks(options?: {
  version?: string;
}): Promise<DoctorCheckResult[]> {
  return [checkNodeVersion(), checkPaseoVersion(options?.version)];
}
