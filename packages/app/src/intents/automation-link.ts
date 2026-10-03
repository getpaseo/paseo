import { buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import { buildHostWorkspaceOpenRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

export const MAX_LINK_PROMPT_LENGTH = 16_000;

type RouteParam = string | string[] | undefined;

export function readLinkParam(value: RouteParam): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Link prompts are bounded so a hostile link cannot wedge the composer. */
export function readLinkPrompt(value: RouteParam): string | null {
  const prompt = readLinkParam(value);
  if (!prompt) {
    return null;
  }
  return prompt.replace(/\r\n?/g, "\n").slice(0, MAX_LINK_PROMPT_LENGTH);
}

export function readLinkFlag(value: RouteParam): boolean {
  const flag = readLinkParam(value)?.toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

export type LinkHostResolution =
  | { kind: "resolved"; serverId: string }
  | { kind: "unknownHost"; serverId: string }
  | { kind: "noHosts" }
  | { kind: "ambiguous" };

/**
 * A link may omit the host. The last workspace the user opened decides, then
 * the only configured host; with several hosts and no history the link has to
 * say which one.
 */
export function resolveLinkHost(input: {
  requestedServerId: string | null;
  hosts: readonly { serverId: string }[];
  lastServerId: string | null;
}): LinkHostResolution {
  const known = new Set(input.hosts.map((host) => host.serverId));
  if (input.requestedServerId) {
    return known.has(input.requestedServerId)
      ? { kind: "resolved", serverId: input.requestedServerId }
      : { kind: "unknownHost", serverId: input.requestedServerId };
  }
  if (known.size === 0) {
    return { kind: "noHosts" };
  }
  if (input.lastServerId && known.has(input.lastServerId)) {
    return { kind: "resolved", serverId: input.lastServerId };
  }
  if (known.size === 1) {
    return { kind: "resolved", serverId: input.hosts[0].serverId };
  }
  return { kind: "ambiguous" };
}

export function buildAgentLinkRoute(input: {
  serverId: string;
  agentId: string;
  prompt: string | null;
  send: boolean;
}) {
  const base = buildAgentDeepLinkRoute({ serverId: input.serverId, agentId: input.agentId });
  const params = new URLSearchParams();
  if (input.prompt) {
    params.set("prompt", input.prompt);
  }
  if (input.send) {
    params.set("send", "true");
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function buildWorkspaceLinkRoute(input: {
  serverId: string;
  workspaceId: string;
  agentId: string | null;
  terminalId: string | null;
}) {
  if (input.agentId) {
    return buildHostWorkspaceOpenRoute(input.serverId, input.workspaceId, `agent:${input.agentId}`);
  }
  if (input.terminalId) {
    return buildHostWorkspaceOpenRoute(
      input.serverId,
      input.workspaceId,
      `terminal:${input.terminalId}`,
    );
  }
  return buildHostWorkspaceRoute(input.serverId, input.workspaceId);
}
