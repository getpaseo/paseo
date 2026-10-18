import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { MenuHint, MenuItem, type MenuPageDefinition } from "@/components/ui/menu";
import {
  useSidebarSelectionEntries,
  type SidebarBatchSelectionEntry,
} from "@/hooks/use-sidebar-batch-actions";
import { useSidebarSelectionStore } from "@/stores/sidebar-selection-store";
import { WorkspaceLabelDot } from "./swatch";
import {
  useWorkspaceLabelProjection,
  useWorkspaceLabels,
  workspaceLabelErrorMessage,
  workspaceLabels,
  type WorkspaceLabelHostSnapshot,
} from "./index";

/** The `MenuSubTrigger` on a batch menu that opens the assign-to-all page. */
export const WORKSPACE_LABEL_BATCH_PAGE_ID = "workspaceLabelsBatch";

/**
 * The batch label page behind a multi-selection's menu.
 *
 * Add-only: a press assigns one label to every selected workspace whose host knows it, and never
 * removes anything. A workspace on a host without that label definition is skipped — assigning a
 * name a host has never seen would fail, so it does not pretend.
 *
 * It resolves the selection itself, so the page only subscribes once it is actually open.
 */
export function WorkspaceLabelBatchPickerPage({
  anchorServerId,
}: {
  anchorServerId: string;
}): ReactElement {
  const { t } = useTranslation();
  const targets = useSidebarSelectionStore((state) => state.selected);
  const entries = useSidebarSelectionEntries(targets);
  const { targetHost: host } = useWorkspaceLabelProjection(anchorServerId);
  const hostsById = useWorkspaceLabels((state) => state.hosts);
  const [pendingNames, setPendingNames] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const offline = host?.status !== "online";
  const rows = useMemo(
    () => buildBatchLabelRows({ entries, catalog: host?.labels ?? [], hostsById }),
    [entries, host?.labels, hostsById],
  );

  const assign = useCallback((row: BatchLabelRowModel) => {
    setPendingNames((current) => new Set(current).add(workspaceLabelKey(row.name)));
    setError(null);
    const results = row.eligible.map((entry) =>
      workspaceLabels.setAssignment({
        serverId: entry.serverId,
        workspaceId: entry.workspaceId,
        label: { name: row.name, color: row.color },
        assigned: true,
      }),
    );
    void Promise.all(results)
      .catch((cause: unknown) => setError(workspaceLabelErrorMessage(cause)))
      .finally(() => {
        setPendingNames((current) => {
          const next = new Set(current);
          next.delete(workspaceLabelKey(row.name));
          return next;
        });
      });
  }, []);

  return (
    <>
      {rows.map((row) => (
        <WorkspaceLabelBatchAssignRow
          key={workspaceLabelKey(row.name)}
          row={row}
          offline={offline}
          pending={pendingNames.has(workspaceLabelKey(row.name))}
          onAssign={assign}
        />
      ))}
      {rows.length === 0 ? <MenuHint>{t("workspaceLabels.manage.empty")}</MenuHint> : null}
      {error ? <MenuHint testID="workspace-label-batch-error">{error}</MenuHint> : null}
      {host?.status === "unsupported" ? (
        <MenuHint>{t("workspaceLabels.updateHostUse")}</MenuHint>
      ) : null}
    </>
  );
}

const WorkspaceLabelBatchAssignRow = memo(function WorkspaceLabelBatchAssignRow({
  row,
  offline,
  pending,
  onAssign,
}: {
  row: BatchLabelRowModel;
  offline: boolean;
  pending: boolean;
  onAssign: (row: BatchLabelRowModel) => void;
}): ReactElement {
  const leading = useMemo(() => <WorkspaceLabelDot color={row.color} />, [row.color]);
  const select = useCallback(() => onAssign(row), [onAssign, row]);
  return (
    <MenuItem
      leading={leading}
      selected={row.assignedToAll}
      disabled={offline || row.eligible.length === 0}
      status={pending ? "pending" : "idle"}
      closeOnSelect={false}
      onSelect={select}
      testID={`workspace-label-batch-row-${row.name}`}
    >
      {row.name}
    </MenuItem>
  );
});

interface BatchLabelRowModel {
  name: string;
  color: WorkspaceLabelDefinition["color"];
  /** Selected workspaces whose host has this label definition and are not going away. */
  eligible: readonly SidebarBatchSelectionEntry[];
  /** Every eligible workspace already carries the label, so the row reads as ticked. */
  assignedToAll: boolean;
}

function buildBatchLabelRows(input: {
  entries: readonly SidebarBatchSelectionEntry[];
  catalog: readonly WorkspaceLabelDefinition[];
  hostsById: Readonly<Record<string, WorkspaceLabelHostSnapshot>>;
}): BatchLabelRowModel[] {
  const { entries, catalog, hostsById } = input;
  return catalog.map((definition) => {
    const key = workspaceLabelKey(definition.name);
    const eligible = entries.filter((entry) => {
      if (entry.workspace === null || entry.workspace.archivingAt != null) return false;
      const host = hostsById[entry.serverId];
      if (host?.status !== "online") return false;
      return host.labels.some((label) => workspaceLabelKey(label.name) === key);
    });
    const assignedToAll =
      eligible.length > 0 &&
      eligible.every(
        (entry) =>
          entry.workspace?.labels?.some((name) => workspaceLabelKey(name) === key) === true,
      );
    return { name: definition.name, color: definition.color, eligible, assignedToAll };
  });
}

/**
 * The one page behind a batch menu's label row. Built from the anchor host alone — the page
 * itself resolves the selection once it opens, so building this per row costs nothing.
 */
export function useSidebarBatchLabelMenuPages(
  anchorServerId: string | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!anchorServerId) return [];
    return [
      {
        id: WORKSPACE_LABEL_BATCH_PAGE_ID,
        title: t("workspaceLabels.title"),
        content: <WorkspaceLabelBatchPickerPage anchorServerId={anchorServerId} />,
      },
    ];
  }, [anchorServerId, t]);
}
