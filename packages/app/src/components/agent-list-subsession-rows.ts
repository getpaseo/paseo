import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";

export interface SubsessionRowModel {
  sub: AgentSubsessionPayload;
  depth: number;
}

/**
 * Order an agent's subsessions as a depth-first tree. Roots are subsessions
 * whose parent is not another subsession (i.e. they hang off the agent's own
 * root session). Cycle-safe via an emitted guard; nodes unreachable from any
 * root still render at depth 1 so nothing is silently dropped.
 */
export function buildSubsessionRows(
  subsessions: readonly AgentSubsessionPayload[] | undefined,
): SubsessionRowModel[] {
  if (!subsessions || subsessions.length === 0) {
    return [];
  }
  const byId = new Map(subsessions.map((sub) => [sub.id, sub]));
  const childrenByParent = new Map<string, AgentSubsessionPayload[]>();
  const roots: AgentSubsessionPayload[] = [];
  for (const sub of subsessions) {
    const parentId = sub.parentSessionId ?? null;
    if (parentId !== null && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(sub);
      childrenByParent.set(parentId, siblings);
    } else {
      roots.push(sub);
    }
  }

  const rows: SubsessionRowModel[] = [];
  const emitted = new Set<string>();
  const emit = (sub: AgentSubsessionPayload, depth: number): void => {
    if (emitted.has(sub.id)) return;
    emitted.add(sub.id);
    rows.push({ sub, depth });
    for (const child of childrenByParent.get(sub.id) ?? []) {
      emit(child, depth + 1);
    }
  };
  for (const root of roots) {
    emit(root, 1);
  }
  // Safety net: cycle members unreachable from any root still render.
  for (const sub of subsessions) {
    emit(sub, 1);
  }
  return rows;
}
