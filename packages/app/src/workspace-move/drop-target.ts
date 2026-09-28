// A sidebar drop target names a workspace as "<serverId>|<workspaceId>". Lists mark their own
// container so a drop inside the list stays a reorder.
export const DROP_TARGET_ATTRIBUTE = "data-workspace-drop-target";
export const DRAG_LIST_ATTRIBUTE = "data-drag-list";

export interface WorkspaceDropTarget {
  serverId: string;
  workspaceId: string;
}

export function encodeWorkspaceDropTarget(target: WorkspaceDropTarget): string {
  return `${target.serverId}|${target.workspaceId}`;
}

export function decodeWorkspaceDropTarget(
  value: string | null | undefined,
): WorkspaceDropTarget | null {
  if (!value) return null;
  const separator = value.indexOf("|");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { serverId: value.slice(0, separator), workspaceId: value.slice(separator + 1) };
}

/** The pointer's position when a dnd-kit drag ended: where it started plus how far it moved. */
export function dragEndPoint(
  activatorEvent: Event | null,
  delta: { x: number; y: number },
): { x: number; y: number } | null {
  const start = activatorEvent as (Partial<MouseEvent> & Partial<TouchEvent>) | null;
  const touch = start?.changedTouches?.[0] ?? start?.touches?.[0];
  const x = touch?.clientX ?? start?.clientX;
  const y = touch?.clientY ?? start?.clientY;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x: x + delta.x, y: y + delta.y };
}

/**
 * The workspace under the pointer, looking past the dragged row itself. A target inside
 * the list the drag started in is ignored: that drop is a reorder.
 */
export function findWorkspaceDropTarget(input: {
  point: { x: number; y: number } | null;
  ownListId: string | null;
  draggedNode: Element | null;
}): WorkspaceDropTarget | null {
  const { point, ownListId, draggedNode } = input;
  if (!point || typeof document === "undefined" || !document.elementsFromPoint) return null;
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    if (draggedNode?.contains(element)) continue;
    const target = element.closest(`[${DROP_TARGET_ATTRIBUTE}]`);
    if (!target) continue;
    const list = target.closest(`[${DRAG_LIST_ATTRIBUTE}]`);
    if (ownListId && list?.getAttribute(DRAG_LIST_ATTRIBUTE) === ownListId) return null;
    return decodeWorkspaceDropTarget(target.getAttribute(DROP_TARGET_ATTRIBUTE));
  }
  return null;
}
