import { getScriptConfigs, isServiceScript, readPaseoConfig } from "../../utils/worktree.js";

export interface ConfiguredServiceOptions {
  autoStart: boolean;
  openWhenHealthy: boolean;
}

export function listConfiguredServiceOptions(cwd: string): Map<string, ConfiguredServiceOptions> {
  const result = readPaseoConfig(cwd);
  if (!result.ok) return new Map();
  return new Map(
    [...getScriptConfigs(result.config)].flatMap(([scriptName, config]) =>
      isServiceScript(config)
        ? [
            [
              scriptName,
              {
                autoStart: config.autoStart === true,
                openWhenHealthy: config.openWhenHealthy === true,
              },
            ] as const,
          ]
        : [],
    ),
  );
}
