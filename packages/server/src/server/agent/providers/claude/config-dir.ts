import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderRuntimeSettings } from "@getpaseo/protocol/provider-config";
import type { ProcessEnvRecord } from "../../../paseo-env.js";
import { createProviderEnv } from "../../provider-launch-config.js";

export interface ClaudeConfigDirSources {
  runtimeSettings?: ProviderRuntimeSettings;
  overlays?: Array<ProcessEnvRecord | undefined>;
}

// Resolves CLAUDE_CONFIG_DIR from the same env Claude Code is launched with, so
// transcripts are read back from the directory the CLI writes them to. A custom
// provider carries its own CLAUDE_CONFIG_DIR, which the daemon-wide environment
// cannot represent once a second profile exists.
export function resolveClaudeConfigDir(sources?: ClaudeConfigDirSources): string {
  const env = createProviderEnv({
    baseEnv: process.env,
    runtimeSettings: sources?.runtimeSettings,
    overlays: sources?.overlays,
  });
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? configDir : join(homedir(), ".claude");
}
