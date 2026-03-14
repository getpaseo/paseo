import { resolvePaseoHome } from "../paseo-home.js";
import { runProviderChecks } from "./checks/provider-checks.js";
import { runConfigChecks } from "./checks/config-checks.js";
import { runRuntimeChecks } from "./checks/runtime-checks.js";
import type { DoctorReport } from "./types.js";

export async function runDoctorChecks(options?: {
  paseoHome?: string;
  version?: string;
}): Promise<DoctorReport> {
  const paseoHome = options?.paseoHome ?? resolvePaseoHome();

  const checks = [
    ...(await runProviderChecks()),
    ...(await runConfigChecks(paseoHome)),
    ...(await runRuntimeChecks({ version: options?.version })),
  ];

  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    error: checks.filter((c) => c.status === "error").length,
  };

  return { checks, summary, timestamp: new Date().toISOString() };
}
