import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { OpenCodeV2PermissionRule } from "./options.js";
import { resolveOpenCodeV2HomeDir } from "./paths.js";

/**
 * The opencode2 config directory inside the isolated home. The server runs with
 * `XDG_CONFIG_HOME = $PASEO_HOME/opencode2-home/.config`, and opencode2 reads
 * its global config from `$XDG_CONFIG_HOME/opencode/opencode.json`.
 */
export function resolveOpenCodeV2ConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenCodeV2HomeDir(env), ".config", "opencode");
}

export function resolveOpenCodeV2ConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenCodeV2ConfigDir(env), "opencode.json");
}

/**
 * Write v2 permission rules into the isolated opencode2 config's `permissions`
 * array. The `opencode.config.agent` plugin appends global `permissions` to
 * every agent and reloads the config on file change, so the rules apply to the
 * shared server (fresh spawns read them at startup; running servers reload
 * within ~1s).
 *
 * The isolated config dir is paseo-owned, so this is safe to write without
 * touching the user's real opencode config. Existing config keys are preserved;
 * only `permissions` is replaced. A no-op when there are no rules.
 *
 * `homeDir` is the isolated opencode2 home the server runs in (the server
 * manager's `getHomeDir()`), so the rules land in the same config the server
 * reads — not wherever the daemon process env happens to point.
 */
export function applyOpenCodeV2PermissionConfig(
  rules: OpenCodeV2PermissionRule[] | undefined,
  logger: Logger,
  homeDir: string,
): void {
  if (!rules || rules.length === 0) {
    return;
  }
  const file = path.join(homeDir, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(file), { recursive: true });
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    }
  } catch (error) {
    logger.warn(
      { err: error, file },
      "Failed to read existing opencode2 config; overwriting permissions",
    );
    config = {};
  }
  config.permissions = rules;
  try {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    logger.debug(
      { file, rules: rules.length },
      "Wrote opencode2 permission rules into the isolated config",
    );
  } catch (error) {
    logger.warn(
      { err: error, file },
      "Failed to write opencode2 permission rules into the isolated config",
    );
  }
}
