import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";

export type DesktopNavigationTarget =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "terminal"; serverId: string; workspaceId: string; terminalId: string };

function readId(payload: object, key: string): string {
  const value: unknown = Reflect.get(payload, key);
  return typeof value === "string" ? value.trim() : "";
}

// Reads a deep link target sent by the desktop main process. The workspace id
// is decoded like the workspace route segment, so a link opens the same
// workspace whether or not a window was already open.
export function readDesktopNavigationTarget(payload: unknown): DesktopNavigationTarget | null {
  if (typeof payload !== "object" || payload === null) return null;
  const serverId = readId(payload, "serverId");
  if (!serverId) return null;
  const terminalId = readId(payload, "terminalId");
  const workspaceValue = readId(payload, "workspaceId");
  if (terminalId || workspaceValue) {
    const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
    return workspaceId && terminalId
      ? { kind: "terminal", serverId, workspaceId, terminalId }
      : null;
  }
  const agentId = readId(payload, "agentId");
  return agentId ? { kind: "agent", serverId, agentId } : null;
}
