import { Service } from "@opencode/client/service";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import {
  EXTERNAL_SERVER_URL_ENV,
  SERVER_SCOPE_ENV,
  type ExternalOpenCodeServer,
  type OpenCodeServerScope,
} from "./external-server.js";

export type OpenCodeServiceSelection =
  | { kind: "owned" }
  | { kind: "explicit" | "discovered"; server: ExternalOpenCodeServer };

export async function selectOpenCodeService(input: {
  explicit?: ExternalOpenCodeServer;
  file?: string;
  env?: Record<string, string | undefined>;
  scope?: OpenCodeServerScope;
}): Promise<OpenCodeServiceSelection> {
  const scope = input.scope ?? "shared";
  if (scope !== "shared") {
    if (input.explicit)
      throw new Error(
        `${SERVER_SCOPE_ENV}=${scope} starts Paseo's own OpenCode servers and cannot be combined with ${EXTERNAL_SERVER_URL_ENV}`,
      );
    return { kind: "owned" };
  }
  if (input.explicit) return { kind: "explicit", server: input.explicit };
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
