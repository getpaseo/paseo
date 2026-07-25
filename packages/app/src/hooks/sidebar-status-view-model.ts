import { STATUS_BUCKET_ORDER } from "@/utils/sidebar-agent-state";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";

export type StatusBucket = SidebarWorkspaceEntry["statusBucket"];

export { STATUS_BUCKET_ORDER };

export type StatusGroupKey = StatusBucket | "recently_done";

export const STATUS_GROUP_ORDER: readonly StatusGroupKey[] = [
  "needs_input",
  "failed",
  "attention",
  "running",
  "recently_done",
  "done",
] as const;

export const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Ready to review",
  running: "Working",
  done: "Done",
};

export const STATUS_GROUP_LABELS: Record<StatusGroupKey, string> = {
  ...STATUS_BUCKET_LABELS,
  recently_done: "Recently done",
};

export interface StatusGroup {
  key: StatusGroupKey;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

export interface RecentlyDoneRecency {
  windowMs: number;
  now: number;
}

const MIN_RECENCY_TICK_MS = 5_000;
const MAX_RECENCY_TICK_MS = 60_000;

export function resolveRecencyTickMs(windowMs: number): number | null {
  if (windowMs <= 0) return null;
  return Math.min(MAX_RECENCY_TICK_MS, Math.max(MIN_RECENCY_TICK_MS, Math.round(windowMs / 4)));
}

export function buildStatusGroups(
  workspaces: SidebarWorkspaceEntry[],
  projectNamesByViewKey: Map<string, string>,
  recency?: RecentlyDoneRecency,
): StatusGroup[] {
  const rowsByKey = new Map<StatusGroupKey, SidebarWorkspaceEntry[]>();

  for (const ws of workspaces) {
    const key = resolveStatusGroupKey(ws, recency);
    let rows = rowsByKey.get(key);
    if (!rows) {
      rows = [];
      rowsByKey.set(key, rows);
    }
    rows.push(ws);
  }

  const groups: StatusGroup[] = [];

  for (const key of STATUS_GROUP_ORDER) {
    const rows = rowsByKey.get(key);
    if (!rows || rows.length === 0) continue;

    rows.sort((a, b) => compareStatusRows(a, b, projectNamesByViewKey));
    groups.push({ key, label: STATUS_GROUP_LABELS[key], rows });
  }

  return groups;
}

function resolveStatusGroupKey(
  workspace: SidebarWorkspaceEntry,
  recency: RecentlyDoneRecency | undefined,
): StatusGroupKey {
  if (workspace.statusBucket !== "done" || !recency || recency.windowMs <= 0) {
    return workspace.statusBucket;
  }
  const enteredAt = workspace.statusEnteredAt?.getTime();
  if (enteredAt === undefined) return "done";
  const age = recency.now - enteredAt;
  return age >= 0 && age < recency.windowMs ? "recently_done" : "done";
}

function compareStatusRows(
  a: SidebarWorkspaceEntry,
  b: SidebarWorkspaceEntry,
  projectNamesByViewKey: Map<string, string>,
): number {
  const aTime = a.statusEnteredAt?.getTime() ?? null;
  const bTime = b.statusEnteredAt?.getTime() ?? null;

  if (aTime !== null && bTime !== null) {
    if (aTime !== bTime) return bTime - aTime;
  } else if (aTime !== null) {
    return -1;
  } else if (bTime !== null) {
    return 1;
  }

  const aProject = projectNamesByViewKey.get(a.projectViewKey) ?? "";
  const bProject = projectNamesByViewKey.get(b.projectViewKey) ?? "";
  const projectCmp = aProject.localeCompare(bProject);
  if (projectCmp !== 0) return projectCmp;

  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) return nameCmp;

  return a.workspaceKey.localeCompare(b.workspaceKey);
}

export function buildStatusShortcutIndex(groups: StatusGroup[]): Map<string, number> {
  const index = new Map<string, number>();
  let shortcutNumber = 1;
  for (const group of groups) {
    for (const row of group.rows) {
      if (shortcutNumber > 9) return index;
      index.set(row.workspaceKey, shortcutNumber);
      shortcutNumber += 1;
    }
  }
  return index;
}
