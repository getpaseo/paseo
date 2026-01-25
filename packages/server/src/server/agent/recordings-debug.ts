import { resolve } from "path";

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isPaseoDictationDebugEnabled(): boolean {
  return isTruthyEnv(process.env.PASEO_DICTATION_DEBUG);
}

export function resolveRecordingsDebugDir(explicitEnvVarName: string): string | null {
  const explicit = process.env[explicitEnvVarName];
  if (explicit && explicit.trim()) {
    return resolve(explicit.trim());
  }

  if (!isPaseoDictationDebugEnabled()) {
    return null;
  }

  return resolve(process.cwd(), ".debug/recordings");
}

