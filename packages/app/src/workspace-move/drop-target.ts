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
interface DropSearch {
  point: { x: number; y: number } | null;
  ownListId: string | null;
  draggedNode: Element | null;
}

function findWorkspaceDropElement(
  input: DropSearch,
): { element: Element; target: WorkspaceDropTarget } | null {
  const { point, ownListId, draggedNode } = input;
  if (!point || typeof document === "undefined" || !document.elementsFromPoint) return null;
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    if (draggedNode?.contains(element)) continue;
    const found = element.closest(`[${DROP_TARGET_ATTRIBUTE}]`);
    if (!found) continue;
    const list = found.closest(`[${DRAG_LIST_ATTRIBUTE}]`);
    if (ownListId && list?.getAttribute(DRAG_LIST_ATTRIBUTE) === ownListId) return null;
    const target = decodeWorkspaceDropTarget(found.getAttribute(DROP_TARGET_ATTRIBUTE));
    return target ? { element: found, target } : null;
  }
  return null;
}

export function findWorkspaceDropTarget(input: DropSearch): WorkspaceDropTarget | null {
  return findWorkspaceDropElement(input)?.target ?? null;
}

// Drag feedback is painted straight onto the drop target element: a drag moves every frame
// and must not re-render the sidebar to show where it would land.
const DROP_STATE_ATTRIBUTE = "data-drop-state";
const DROP_FEEDBACK_CSS = `
[${DROP_STATE_ATTRIBUTE}="valid"] { outline: 2px solid #3b82f6; outline-offset: -2px; border-radius: 8px; background-color: rgba(59, 130, 246, 0.14); }
[${DROP_STATE_ATTRIBUTE}="invalid"] { outline: 2px dashed #d93025; outline-offset: -2px; border-radius: 8px; cursor: not-allowed; opacity: 0.6; }
[${DROP_STATE_ATTRIBUTE}="landed"] { outline: 2px solid #188038; outline-offset: -2px; border-radius: 8px; background-color: rgba(24, 128, 56, 0.16); transition: background-color 0.3s; }
`;
let highlighted: Element | null = null;

function ensureDropFeedbackStyles(): void {
  if (typeof document === "undefined" || document.getElementById("paseo-drop-feedback")) return;
  const style = document.createElement("style");
  style.id = "paseo-drop-feedback";
  style.textContent = DROP_FEEDBACK_CSS;
  document.head.appendChild(style);
}

export function clearWorkspaceDropHighlight(): void {
  highlighted?.removeAttribute(DROP_STATE_ATTRIBUTE);
  highlighted = null;
}

/** Marks the workspace under the pointer as a valid or refused drop while a drag moves. */
export function highlightWorkspaceDropTarget(
  input: DropSearch & { isValid: (target: WorkspaceDropTarget) => boolean },
): void {
  const found = findWorkspaceDropElement(input);
  if (found?.element !== highlighted) clearWorkspaceDropHighlight();
  if (!found) return;
  ensureDropFeedbackStyles();
  found.element.setAttribute(
    DROP_STATE_ATTRIBUTE,
    input.isValid(found.target) ? "valid" : "invalid",
  );
  highlighted = found.element;
}

/** Briefly lights up the workspace a drop landed in, so the eye follows the move. */
export function flashLandedWorkspace(target: WorkspaceDropTarget): void {
  if (typeof document === "undefined") return;
  ensureDropFeedbackStyles();
  const value = encodeWorkspaceDropTarget(target).replace(/["\\]/g, "\\$&");
  const matches = [...document.querySelectorAll(`[${DROP_TARGET_ATTRIBUTE}="${value}"]`)];
  // A project header targets its first workspace too; light the workspace row, not the block.
  const innermost = matches.filter(
    (element) => !matches.some((other) => other !== element && element.contains(other)),
  );
  for (const element of innermost) {
    element.setAttribute(DROP_STATE_ATTRIBUTE, "landed");
    setTimeout(() => {
      if (element.getAttribute(DROP_STATE_ATTRIBUTE) === "landed") {
        element.removeAttribute(DROP_STATE_ATTRIBUTE);
      }
    }, 1600);
  }
}
