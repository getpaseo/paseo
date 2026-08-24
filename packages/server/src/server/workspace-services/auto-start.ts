import type { Logger } from "pino";
import { listConfiguredServiceOptions } from "./configured-service-options.js";

export async function startConfiguredAutoStartServices(options: {
  cwd: string;
  workspaceId: string;
  launch: (scriptName: string) => Promise<void>;
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  const configured = listConfiguredServiceOptions(options.cwd);
  for (const [scriptName, service] of configured) {
    if (!service.autoStart) continue;
    try {
      await options.launch(scriptName);
    } catch (error) {
      options.logger.warn(
        { err: error, workspaceId: options.workspaceId, scriptName },
        "Failed to auto-start workspace service",
      );
    }
  }
}
