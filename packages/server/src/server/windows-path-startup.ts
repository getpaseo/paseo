import type { Logger } from "pino";
import { refreshWindowsProcessPath } from "../executable-resolution/windows.js";

/**
 * Adds the PATH entries the Windows user environment holds.
 *
 * A registry query that could not run — a timeout, a denied key, a missing
 * reg.exe — is reported and the inherited PATH is kept. Failing here would
 * stop the daemon from starting over a PATH refresh that is an improvement,
 * not a requirement.
 */
export async function refreshWindowsPathForStartup(
  logger: Pick<Logger, "info" | "warn">,
  refresh: () => Promise<{ added: string[] }> = refreshWindowsProcessPath,
): Promise<void> {
  try {
    const result = await refresh();
    if (result.added.length > 0) {
      logger.info({ added: result.added }, "Added PATH entries from the Windows user environment");
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Could not read the Windows user PATH; continuing with the inherited PATH",
    );
  }
}
