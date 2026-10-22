import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePaseoHome } from "./paseo-home.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function agentBrowserEnv(
  workspaceId: string,
  owner: { kind: "agent" | "terminal"; id: string },
  paseoHome = resolvePaseoHome(),
): Record<string, string> {
  return {
    AGENT_BROWSER_NAMESPACE: `p-${digest(JSON.stringify([resolve(paseoHome), workspaceId]))}`,
    // A fixed base avoids inheriting a shell's socket location. Keep Unix socket paths short.
    AGENT_BROWSER_SOCKET_DIR: join(homedir(), ".agent-browser"),
    AGENT_BROWSER_SESSION: `${owner.kind === "agent" ? "a" : "t"}-${digest(owner.id).slice(0, 12)}`,
  };
}
