import type { TFunction } from "i18next";
import { STATUS_BUCKET_ORDER } from "@/utils/sidebar-agent-state";
import {
  applyStoredOrdering,
  compareSidebarActivity,
  compareSidebarNames,
  type SidebarWorkspaceEntry,
} from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarSortMode } from "@/stores/sidebar-view-store";

export type StatusBucket = SidebarWorkspaceEntry["statusBucket"];

export { STATUS_BUCKET_ORDER };

const STATUS_BUCKET_LABEL_KEYS = {
  needs_input: "sidebar.statusBucket.needsInput",
  failed: "sidebar.statusBucket.failed",
  attention: "sidebar.statusBucket.readyToReview",
  running: "sidebar.statusBucket.working",
  done: "sidebar.statusBucket.done",
} as const satisfies Record<StatusBucket, string>;

export function getStatusBucketLabel(bucket: StatusBucket, t: TFunction): string {
  return t(STATUS_BUCKET_LABEL_KEYS[bucket]);
}

export interface StatusGroup {
  bucket: StatusBucket;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

export function buildStatusGroups(input: {
  workspaces: SidebarWorkspaceEntry[];
  projectNamesByViewKey: Map<string, string>;
  t: TFunction;
  sortMode?: SidebarSortMode;
  runningFirst?: boolean;
  workspaceOrderByStatus?: Readonly<Record<string, string[]>>;
}): StatusGroup[] {
  const { workspaces, projectNamesByViewKey, t, sortMode = "manual", runningFirst = false } = input;
  const bucketRows = new Map<StatusBucket, SidebarWorkspaceEntry[]>();

  for (const ws of workspaces) {
    const bucket: StatusBucket = ws.statusBucket;
    let rows = bucketRows.get(bucket);
    if (!rows) {
      rows = [];
      bucketRows.set(bucket, rows);
    }
    rows.push(ws);
  }

  const groups: StatusGroup[] = [];

  for (const bucket of STATUS_BUCKET_ORDER) {
    const rows = bucketRows.get(bucket);
    if (!rows || rows.length === 0) continue;

    rows.sort((a, b) => {
      if (sortMode === "name") return compareSidebarNames(a.name, b.name);
      if (sortMode === "recent") return compareSidebarActivity(a, b, runningFirst);
      return compareStatusRows(a, b, projectNamesByViewKey);
    });
    const orderedRows =
      sortMode === "manual"
        ? applyStoredOrdering({
            items: rows,
            storedOrder: input.workspaceOrderByStatus?.[bucket] ?? [],
            getKey: (row) => row.workspaceKey,
          })
        : rows;
    groups.push({ bucket, label: getStatusBucketLabel(bucket, t), rows: orderedRows });
  }

  return groups;
}

function compareStatusRows(
  a: SidebarWorkspaceEntry,
  b: SidebarWorkspaceEntry,
  projectNamesByViewKey: Map<string, string>,
): number {
  const aTimestamp = a.statusEnteredAt;
  const bTimestamp = b.statusEnteredAt;
  const aTime = aTimestamp?.getTime() ?? null;
  const bTime = bTimestamp?.getTime() ?? null;

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
