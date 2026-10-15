import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentStorage, createRootLogger, resolvePaseoHome } from "@getpaseo/server";
import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

const SESSION_JUMP_PROTOCOL = "paseo-local:";

export function isAgentSessionJump(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === SESSION_JUMP_PROTOCOL && url.hostname === "focus";
  } catch {
    return false;
  }
}

export function findAgentSessionJumpInArgv(argv: string[]): string | null {
  return argv.find(isAgentSessionJump) ?? null;
}

export async function resolveAgentSessionJump(
  input: string,
  options: { paseoHome?: string } = {},
): Promise<AgentDeepLinkTarget | null> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== SESSION_JUMP_PROTOCOL ||
    url.hostname !== "focus" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }

  const session = url.searchParams.get("session")?.trim();
  if (!session) return null;
  const cwd = url.searchParams.get("cwd");
  const paseoHome = options.paseoHome ?? resolvePaseoHome();
  let serverId: string;
  try {
    serverId = (await readFile(path.join(paseoHome, "server-id"), "utf8")).trim();
  } catch {
    return null;
  }
  if (!serverId) return null;

  const storage = new AgentStorage(
    path.join(paseoHome, "agents"),
    createRootLogger(undefined, { paseoHome, file: false }),
  );
  const matches = (await storage.list()).filter((agent) => {
    if (agent.archivedAt || agent.internal || (cwd !== null && agent.cwd !== cwd)) return false;
    const persistence = agent.persistence;
    if (!persistence) return false;
    if (persistence.sessionId === session || persistence.nativeHandle === session) return true;
    return (
      persistence.provider === "codex" &&
      session.startsWith("codex-") &&
      (persistence.sessionId === session.slice("codex-".length) ||
        persistence.nativeHandle === session.slice("codex-".length))
    );
  });

  return matches.length === 1 ? { serverId, agentId: matches[0].id } : null;
}
