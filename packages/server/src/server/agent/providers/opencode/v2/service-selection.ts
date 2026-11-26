import { Service } from "@opencode/client/service";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import type { ExternalOpenCodeServer } from "./external-server.js";

export type OpenCodeServiceSelection =
  | { kind: "owned" }
  | { kind: "explicit" | "discovered"; server: ExternalOpenCodeServer };

// Provider env keys that choose and reach a server rather than configure its process.
const CONNECTION_ENV = new Set([
  "PASEO_OPENCODE_SERVER_URL",
  "PASEO_OPENCODE_SERVER_PASSWORD",
  "PASEO_OPENCODE_BRIDGE_URL",
  "PASEO_OPENCODE_BRIDGE_PORT",
]);
// A discovered service is found through these, and its configuration directory is checked.
const DISCOVERY_ENV = new Set(["XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]);

/** Provider env keys that only apply to an OpenCode process Paseo starts itself. */
export function processEnvironmentOverrides(
  env: Record<string, string | undefined> | undefined,
  kind: "explicit" | "discovered" = "explicit",
): string[] {
  return Object.keys(env ?? {}).filter(
    (key) => !CONNECTION_ENV.has(key) && !(kind === "discovered" && DISCOVERY_ENV.has(key)),
  );
}

export async function selectOpenCodeService(input: {
  explicit?: ExternalOpenCodeServer;
  file?: string;
  env?: Record<string, string | undefined>;
}): Promise<OpenCodeServiceSelection> {
  if (input.explicit) return { kind: "explicit", server: input.explicit };
  if (processEnvironmentOverrides(input.env, "discovered").length) return { kind: "owned" };
  const state =
    input.env?.XDG_STATE_HOME ??
    process.env.XDG_STATE_HOME ??
    path.join(homedir(), ".local", "state");
  const endpoint = await Service.discover({
    file: input.file ?? path.join(state, "opencode", "service.json"),
    version: compatibleVersion,
  }).catch(() => undefined);
  if (!endpoint) return { kind: "owned" };
  if (!isLocalOpenCodeHost(new URL(endpoint.url).hostname)) return { kind: "owned" };
  return {
    kind: "discovered",
    server: { url: endpoint.url, ...(endpoint.auth ? { password: endpoint.auth.password } : {}) },
  };
}

export function isLocalOpenCodeHost(input: string): boolean {
  const hostname = input.replace(/^\[|\]$/g, "");
  const localAddresses = Object.values(networkInterfaces()).flatMap((items) =>
    (items ?? []).map((item) => item.address),
  );
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ...localAddresses].includes(hostname);
}

export function compatibleVersion(version: string): boolean {
  const match = /^2\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 10));
}
