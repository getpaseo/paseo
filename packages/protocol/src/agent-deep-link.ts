export interface AgentDeepLinkTarget {
  serverId: string;
  agentId: string;
}

function normalizeSegment(value: string): string {
  return value.trim();
}

export function buildAgentDeepLink(target: AgentDeepLinkTarget): string {
  const serverId = normalizeSegment(target.serverId);
  const agentId = normalizeSegment(target.agentId);
  if (!serverId || !agentId) {
    throw new Error("Agent deep links require a server ID and agent ID.");
  }
  return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

export function buildAgentDeepLinkRoute(target: AgentDeepLinkTarget): string {
  const link = new URL(buildAgentDeepLink(target));
  return `/h${link.pathname}`;
}

export function parseAgentDeepLink(input: string): AgentDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "h" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[1] !== "agent") {
    return null;
  }

  try {
    const serverId = normalizeSegment(decodeURIComponent(segments[0] ?? ""));
    const agentId = normalizeSegment(decodeURIComponent(segments[2] ?? ""));
    return serverId && agentId ? { serverId, agentId } : null;
  } catch {
    return null;
  }
}
