import path from "node:path";

import { resolvePaseoHome } from "../../../paseo-home.js";

const OPENCODE_V2_HOME_DIRNAME = "opencode2-home";

/**
 * Isolated opencode2 home. The v2 server runs with HOME (and the XDG dirs)
 * pointed here so its config, data, and cache never touch the user's real
 * opencode config.
 */
export function resolveOpenCodeV2HomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), OPENCODE_V2_HOME_DIRNAME);
}
