import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_DIRNAME = ".pandaos";
export const LEGACY_HOME_DIRNAME = ".paseo";

function expandHomeDir(input: string, homeDir: string): string {
  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }
  if (input === "~") {
    return homeDir;
  }
  return input;
}

export function resolvePaseoHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  // COMPAT(paseoHomeEnv): PASEO_HOME predates PANDAOS_HOME; remove after 2027-04-01 once no launcher sets it.
  const explicit = env.PANDAOS_HOME || env.PASEO_HOME;
  if (explicit) {
    return path.resolve(expandHomeDir(explicit, homeDir));
  }
  const home = path.join(homeDir, HOME_DIRNAME);
  const legacyHome = path.join(homeDir, LEGACY_HOME_DIRNAME);
  // COMPAT(legacyHomeDir): an unmigrated install keeps running from ~/.paseo until `pandaos home migrate`;
  // remove after 2027-04-01 together with the migrate command.
  if (!existsSync(home) && existsSync(legacyHome)) {
    return legacyHome;
  }
  return home;
}
