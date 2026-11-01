export interface AgentDeepLinkTarget {
  serverId: string;
  agentId: string;
}

export interface TerminalDeepLinkTarget {
  serverId: string;
  workspaceId: string;
  terminalId: string;
}

export type DesktopDeepLinkTarget = AgentDeepLinkTarget | TerminalDeepLinkTarget;

function normalizeSegment(value: string): string {
  return value.trim();
}

function normalizeAgentDeepLinkTarget(target: AgentDeepLinkTarget): AgentDeepLinkTarget {
  const serverId = normalizeSegment(target.serverId);
  const agentId = normalizeSegment(target.agentId);
  if (!serverId || !agentId) {
    throw new Error("Agent deep links require a server ID and agent ID.");
  }
  return { serverId, agentId };
}

function normalizeTerminalDeepLinkTarget(target: TerminalDeepLinkTarget): TerminalDeepLinkTarget {
  const serverId = normalizeSegment(target.serverId);
  const workspaceId = normalizeSegment(target.workspaceId);
  const terminalId = normalizeSegment(target.terminalId);
  if (!serverId || !workspaceId || !terminalId) {
    throw new Error("Terminal deep links require a server ID, workspace ID, and terminal ID.");
  }
  return { serverId, workspaceId, terminalId };
}

export function buildAgentDeepLinkRoute(
  target: AgentDeepLinkTarget,
): `/h/${string}/agent/${string}` {
  const { serverId, agentId } = normalizeAgentDeepLinkTarget(target);
  return `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

export function buildAgentDeepLink(target: AgentDeepLinkTarget): string {
  return `paseo:/${buildAgentDeepLinkRoute(target)}`;
}

export function buildTerminalDeepLink(target: TerminalDeepLinkTarget): string {
  const { serverId, workspaceId, terminalId } = normalizeTerminalDeepLinkTarget(target);
  return `paseo://h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(terminalId)}`;
}

export function isTerminalDeepLinkTarget(
  target: DesktopDeepLinkTarget,
): target is TerminalDeepLinkTarget {
  return "terminalId" in target;
}

// The in-app route that opens the target: the agent route, or the workspace
// route with an `open=terminal:<id>` intent that selects the terminal tab.
export function buildDesktopDeepLinkRoute(target: DesktopDeepLinkTarget): string {
  if (!isTerminalDeepLinkTarget(target)) {
    return buildAgentDeepLinkRoute(target);
  }
  const { serverId, workspaceId, terminalId } = normalizeTerminalDeepLinkTarget(target);
  const workspaceRoute = `/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(workspaceId)}`;
  return `${workspaceRoute}?open=${encodeURIComponent(`terminal:${terminalId}`)}`;
}

function parseHostDeepLinkSegments(input: string): string[] | null {
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

  return url.pathname.split("/").filter(Boolean);
}

function decodeSegments(segments: string[]): string[] | null {
  try {
    const decoded = segments.map((segment) => normalizeSegment(decodeURIComponent(segment)));
    return decoded.every(Boolean) ? decoded : null;
  } catch {
    return null;
  }
}

export function parseAgentDeepLink(input: string): AgentDeepLinkTarget | null {
  const segments = parseHostDeepLinkSegments(input);
  if (!segments || segments.length !== 3 || segments[1] !== "agent") {
    return null;
  }

  const decoded = decodeSegments([segments[0] ?? "", segments[2] ?? ""]);
  if (!decoded) {
    return null;
  }
  const [serverId = "", agentId = ""] = decoded;
  return { serverId, agentId };
}

// `paseo://h/<serverId>/workspace/<workspaceId>/terminal/<terminalId>`. The
// workspace segment uses the same form as the app's workspace route.
export function parseTerminalDeepLink(input: string): TerminalDeepLinkTarget | null {
  const segments = parseHostDeepLinkSegments(input);
  if (
    !segments ||
    segments.length !== 5 ||
    segments[1] !== "workspace" ||
    segments[3] !== "terminal"
  ) {
    return null;
  }

  const decoded = decodeSegments([segments[0] ?? "", segments[2] ?? "", segments[4] ?? ""]);
  if (!decoded) {
    return null;
  }
  const [serverId = "", workspaceId = "", terminalId = ""] = decoded;
  return { serverId, workspaceId, terminalId };
}

export function parseDesktopDeepLink(input: string): DesktopDeepLinkTarget | null {
  return parseAgentDeepLink(input) ?? parseTerminalDeepLink(input);
}
