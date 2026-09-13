import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { existsSync } from "node:fs";

export class WritePolicyUnsupportedError extends Error {
  readonly code = "write_policy_unsupported";
  constructor(readonly provider: string) {
    super(`Provider '${provider}' cannot enforce read_only on this host`);
    this.name = "WritePolicyUnsupportedError";
  }
}

export function supportsWritePolicy(
  provider: string,
  policy: NonNullable<AgentSessionConfig["writePolicy"]>,
): boolean {
  return (
    policy === "read_write" ||
    (provider === "codex" && process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
  );
}

export function assertWritePolicySupported(
  config: Pick<AgentSessionConfig, "provider" | "writePolicy">,
): void {
  if (
    config.writePolicy !== undefined &&
    !supportsWritePolicy(config.provider, config.writePolicy)
  ) {
    throw new WritePolicyUnsupportedError(config.provider);
  }
}

export function assertWritePolicyUnchanged(
  original: Pick<AgentSessionConfig, "writePolicy">,
  overrides?: Pick<AgentSessionConfig, "writePolicy">,
): void {
  if (
    overrides?.writePolicy !== undefined &&
    overrides.writePolicy !== (original.writePolicy ?? "read_write")
  ) {
    throw new Error("writePolicy is creation-only");
  }
}
