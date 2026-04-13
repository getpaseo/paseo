import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const PASEO_IDENTITY_PLUGIN_FILE = "paseo-identity-plugin.mjs";

export const PASEO_IDENTITY_PLUGIN_ID = "paseo-identity";

export const PASEO_SESSION_MAP_ENV_VAR = "PASEO_OPENCODE_SESSION_MAP_PATH";

export const PASEO_IDENTITY_PLUGIN_SOURCE = `// Paseo identity plugin for OpenCode.
// Auto-installed by the Paseo daemon. Do not edit manually — changes will be overwritten.
//
// Injects PASEO_AGENT_ID into the shell environment of every tool call based on
// the OpenCode sessionID reported by the runtime. The mapping is maintained by
// the Paseo daemon at the file named in ${PASEO_SESSION_MAP_ENV_VAR}.

import { existsSync, readFileSync, statSync } from "node:fs";

const SESSION_MAP_PATH = process.env.${PASEO_SESSION_MAP_ENV_VAR} ?? "";

let cached = { mtimeMs: 0, map: /** @type {Record<string, string>} */ ({}) };

function readMap() {
  if (!SESSION_MAP_PATH) return {};
  try {
    if (!existsSync(SESSION_MAP_PATH)) return {};
    const stat = statSync(SESSION_MAP_PATH);
    if (stat.mtimeMs === cached.mtimeMs) return cached.map;
    const parsed = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8"));
    const map = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    cached = { mtimeMs: stat.mtimeMs, map };
    return map;
  } catch {
    return cached.map;
  }
}

function resolveAgentId(sessionId) {
  if (!sessionId) return undefined;
  const value = readMap()[sessionId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// File-loaded OpenCode plugins must export an "id" so the runtime loader can
// register them. Both the named export and the PluginModule-shaped default
// export are provided to be compatible with either resolver path.
export const id = "${PASEO_IDENTITY_PLUGIN_ID}";

export const server = async () => {
  return {
    "shell.env": async (input, output) => {
      const agentId = resolveAgentId(input?.sessionID);
      if (agentId) {
        output.env.PASEO_AGENT_ID = agentId;
      }
    },
  };
};

export default { id, server };
`;

export interface InstalledIdentityPlugin {
  filePath: string;
  fileUrl: string;
}

export function installIdentityPlugin(paseoHome: string): InstalledIdentityPlugin {
  const filePath = join(paseoHome, PASEO_IDENTITY_PLUGIN_FILE);
  mkdirSync(dirname(filePath), { recursive: true });

  let existing: string | null = null;
  try {
    existing = readFileSync(filePath, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== PASEO_IDENTITY_PLUGIN_SOURCE) {
    writeFileSync(filePath, PASEO_IDENTITY_PLUGIN_SOURCE, "utf8");
  }

  return {
    filePath,
    fileUrl: pathToFileURL(filePath).href,
  };
}

// Builds the OPENCODE_CONFIG_CONTENT payload for the spawned `opencode serve`.
//
// We only inject our plugin URL — OpenCode merges this `plugin` array with the
// arrays declared in the project's ./opencode.json and the user's global
// config (~/.config/opencode/opencode.json), so the user's existing plugins
// (e.g. qwen-auth, rtk) keep loading untouched.
export function buildOpenCodeServerConfig(pluginFileUrl: string): { plugin: string[] } {
  return { plugin: [pluginFileUrl] };
}
