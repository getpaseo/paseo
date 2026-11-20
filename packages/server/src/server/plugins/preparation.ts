import type pino from "pino";
import type { PluginManifest } from "./manifest.js";
import { runCompilerTask } from "./compiler.js";

export async function runPluginBuild(
  directory: string,
  commands: PluginManifest["build"],
  logger: pino.Logger,
): Promise<void> {
  if (!commands?.length) return;
  await runCompilerTask(
    { kind: "prepare", directory, commands, environment: { ...process.env } },
    (data, message) => logger.info(data, message),
  );
}
