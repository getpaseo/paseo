import pino from "pino";
import { resolvePaseoHome } from "../../server/paseo-home.js";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { ensureForgeCli, type EnsureForgeCliOptions } from "./ensure-forge-cli.js";
import type { ForgeCliId } from "./forge-cli-catalog.js";

// Fallback logger for call sites that don't have a real daemon logger to
// pass in (the zero-arg createGitHubService()/createGitLabService()/
// createGiteaService() call sites in session.ts, websocket-server.ts,
// checkout-git.ts). Logs still go somewhere, stdout at warn+, instead of
// vanishing, since a failed auto-install with no visible reason is
// annoying to debug.
let defaultLogger: pino.Logger | undefined;

function getDefaultLogger(): pino.Logger {
  defaultLogger ??= pino({ level: "warn" });
  return defaultLogger;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function isForgeCliAutoInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanEnv(env.PASEO_FORGE_CLI_AUTOINSTALL) ?? true;
}

export interface EnsureForgeCliWithDefaultsOptions {
  paseoHome?: string;
  logger?: pino.Logger;
  toolsDir?: string;
  autoInstallEnabled?: boolean;
}

/**
 * Ensure a forge CLI is available, falling back to module-level defaults
 * (real $PASEO_HOME, a warn-level logger, live env for the enable flag) for
 * whatever the caller didn't pass in. Lets the bare `createXService()` call
 * sites (session.ts/websocket-server.ts fallbacks, checkout-git.ts default
 * params) get auto-install without needing to thread real daemon config.
 */
export function ensureForgeCliWithDefaults(
  cli: ForgeCliId,
  options: EnsureForgeCliWithDefaultsOptions = {},
): Promise<string | null> {
  const autoInstallEnabled = options.autoInstallEnabled ?? isForgeCliAutoInstallEnabled();
  if (!autoInstallEnabled) {
    return Promise.resolve(null);
  }

  const ensureOptions: EnsureForgeCliOptions = {
    paseoHome: options.paseoHome ?? resolvePaseoHome(),
    logger: options.logger ?? getDefaultLogger(),
    toolsDir: options.toolsDir,
  };
  return ensureForgeCli(cli, ensureOptions);
}

// The one place that decides "PATH first, then auto-install" for a forge
// CLI. Both the bare module-level resolveGhPath()/resolveGlabPath()/
// resolveTeaPath() (github-service.ts etc, used when nothing is injected)
// and forge-registry.ts's context-aware resolver call this, so there's
// only one fallback implementation, just two different option bags feeding
// it depending on whether real daemon config is available yet.
export async function resolveForgeCliPath(
  cli: ForgeCliId,
  options: EnsureForgeCliWithDefaultsOptions = {},
): Promise<string | null> {
  const found = await findExecutable(cli);
  if (found) {
    return found;
  }
  return ensureForgeCliWithDefaults(cli, options);
}
