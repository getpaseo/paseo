/**
 * Pure decision logic for routing a notification click to a window. Kept free of
 * Electron so it is unit-testable without a running app; `notifications.ts` is the
 * Electron wiring that calls this with real windows.
 */

export type NotificationRoute =
  | { kind: "target"; serverId: string; workspaceId: string | null; agentId: string | null }
  | { kind: "sender" };

function readNonEmptyString(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `{ kind: "sender" }` means the notification data names no server, so there is
 * nothing to look a candidate window up by — deliver to whichever window sent it,
 * exactly as before this feature existed.
 */
export function resolveNotificationRoute(
  data: Record<string, unknown> | undefined,
): NotificationRoute {
  const serverId = readNonEmptyString(data, "serverId");
  if (!serverId) {
    return { kind: "sender" };
  }
  return {
    kind: "target",
    serverId,
    workspaceId: readNonEmptyString(data, "workspaceId"),
    agentId: readNonEmptyString(data, "agentId"),
  };
}

/**
 * `candidates` is the already-ranked (best-first) list of windows showing the route's
 * target — empty when the route is `{ kind: "sender" }` or when nothing matched. Falls
 * back to `sender`, which is today's whole behavior.
 */
export function chooseNotificationClickWindow<TWindow>(input: {
  route: NotificationRoute;
  candidates: readonly TWindow[];
  sender: TWindow | null;
}): TWindow | null {
  if (input.route.kind === "sender") {
    return input.sender;
  }
  return input.candidates[0] ?? input.sender;
}
