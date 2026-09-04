import type { ProjectOrderWrite } from "./project-order-epoch";
import type { ProjectOrderPosition } from "./project-drop-resolution";

/**
 * The moves of projects between groups that are waiting on a host.
 *
 * Module state for the same reason `project-order-writer.ts` is: the sidebar list unmounts when
 * the grouping mode changes or the sidebar closes, and a component-held guard would let the same
 * project be moved twice while its first move is still unanswered, leaving the group it ends up
 * in to whichever host answers last.
 *
 * Only drags record themselves here, and only one move per project at a time. Two known effects,
 * both decided against fixing (a row lands one place lower inside a group for a moment, nothing
 * is lost, and the drag that follows puts it right):
 *
 * - A group set from a project's own menu is invisible to this, so a header drop that follows it
 *   within the host's answer-to-push gap anchors on the row the group still shows first.
 * - Dragging one project into two groups in a row leaves only the second transition recorded, so
 *   the first group's update retires it and a drop on the second group's header misses it.
 *
 * Closing either one means every write path recording itself, which puts this in the
 * project-groups layer and gives its entries a lifetime rather than a guess about staleness.
 */
export interface ProjectGroupMoveTarget {
  groupKey: string | null;
  groupName: string | null;
}

/** A move a host has not answered yet, and the group the sidebar showed when it started. */
interface PendingProjectGroupMove {
  target: string | null;
  from: string | null;
}

/** One move per project. */
const inFlight = new Map<string, PendingProjectGroupMove>();
/**
 * Moves a host accepted whose project record has not been pushed yet. For that moment the
 * sidebar still draws the project in its old group, so a drop on the new group's header has to
 * be told the row is on its way in, or it would land behind it.
 */
const awaitingReplica = new Map<string, PendingProjectGroupMove>();

/**
 * The group each project names, by view key. Pass every project the client knows, not the ones a
 * filter leaves on screen: a project missing from this map is taken to be gone, and a hidden one
 * would lose the record of the move it has waiting.
 */
export type ProjectGroupKeys = ReadonlyMap<string, string | null>;

/**
 * Drops the moves the sidebar has caught up with. Any change to what a project shows means a
 * record arrived, whichever group it named: the entry has said all it can, and keeping it would
 * let a group claim a project that has since been moved somewhere else entirely.
 */
function pruneAwaitingReplica(groupKeysByViewKey: ProjectGroupKeys): void {
  for (const [viewKey, move] of awaitingReplica) {
    if (!groupKeysByViewKey.has(viewKey) || groupKeysByViewKey.get(viewKey) !== move.from) {
      awaitingReplica.delete(viewKey);
    }
  }
}

/**
 * Claims the one slot this project has. Returns null when a move of it is already unanswered.
 * `arrivingKeys` are the rows the target group has taken in but is not showing yet; rows still
 * waiting on a host are not among them, because a refused one never joined the group and the
 * order epoch is what keeps track of the rest.
 */
export function beginProjectGroupMove(input: {
  viewKey: string;
  target: ProjectGroupMoveTarget;
  groupKeysByViewKey: ProjectGroupKeys;
}): { arrivingKeys: Set<string> } | null {
  const { viewKey, target, groupKeysByViewKey } = input;
  if (inFlight.has(viewKey)) return null;
  pruneAwaitingReplica(groupKeysByViewKey);
  const arrivingKeys = new Set(
    [...awaitingReplica.entries()]
      .filter(([, move]) => target.groupKey !== null && move.target === target.groupKey)
      .map(([key]) => key),
  );
  inFlight.set(viewKey, {
    target: target.groupKey,
    from: groupKeysByViewKey.get(viewKey) ?? null,
  });
  return { arrivingKeys };
}

export function finishProjectGroupMove(input: { viewKey: string; accepted: boolean }): void {
  const move = inFlight.get(input.viewKey);
  inFlight.delete(input.viewKey);
  if (input.accepted && move) awaitingReplica.set(input.viewKey, move);
  else awaitingReplica.delete(input.viewKey);
}

/** Test seam: the module holds one set of pending moves for the app's lifetime. */
export function resetProjectGroupMovesForTest(): void {
  inFlight.clear();
  awaitingReplica.clear();
}

/**
 * The stored-order write a drop asks for. A drop that keeps the row's place still writes: the
 * order does not change, but the epoch has to know the row's group did.
 */
export function resolveOrderWrite(input: {
  key: string;
  target: ProjectGroupMoveTarget;
  position: ProjectOrderPosition;
  arrivingKeys: ReadonlySet<string>;
}): ProjectOrderWrite | null {
  const { key, target, position, arrivingKeys } = input;
  switch (position.kind) {
    case "relative":
      return {
        kind: "move",
        key,
        anchorKey: position.anchorViewKey,
        placement: position.placement,
        groupKey: target.groupKey,
      };
    case "group_start":
      // Only a drop onto a group's header asks for this position, so the target always names one.
      return target.groupKey === null
        ? null
        : {
            kind: "group_start",
            key,
            groupKey: target.groupKey,
            firstViewKey: position.firstViewKey,
            arrivingKeys: [...arrivingKeys],
          };
    case "keep":
      return { kind: "membership", key, groupKey: target.groupKey };
  }
}
