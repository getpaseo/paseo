import { useCallback, useMemo, useState, type ReactElement } from "react";
import { FlatList, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  ScheduleRow,
  SchedulesColumnHeader,
  type ScheduleRowPending,
} from "@/components/schedules/schedule-row";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { useIsCompactFormFactor } from "@/constants/layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

interface SchedulesTableProps {
  serverId: string;
  schedules: ScheduleSummary[];
  /**
   * The form sheet is owned by the screen (it serves both create and edit and
   * shares the header's "New schedule" button), so the table delegates edit
   * upward rather than mounting a second sheet here.
   */
  onEditSchedule: (schedule: ScheduleSummary) => void;
}

/**
 * Borderless SaaS table of new-agent schedules. Owns row-level actions
 * (pause/resume/run/delete via the mutations hook + a destructive confirm for
 * delete) and delegates editing to the parent. Row chrome — the hairline
 * between rows, hover highlight, and the compact-vs-desktop layout — lives in
 * ScheduleRow; this component only arranges the rows and the column header.
 */
export function SchedulesTable({
  serverId,
  schedules,
  onEditSchedule,
}: SchedulesTableProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const mutations = useScheduleMutations({ serverId });

  const renderItem: ListRenderItem<ScheduleSummary> = useCallback(
    ({ item }) => (
      <SchedulesTableRow schedule={item} mutations={mutations} onEditSchedule={onEditSchedule} />
    ),
    [mutations, onEditSchedule],
  );

  // The desktop column header aligns with the rows because both live inside the
  // same horizontally padded, width-constrained content container and share the
  // row's flex column weights. Compact rows are self-labeled, so no header.
  const listHeader = useMemo(() => (isCompact ? null : <SchedulesColumnHeader />), [isCompact]);

  const contentContainerStyle = useMemo(
    () => [styles.listContent, isCompact ? styles.listContentCompact : styles.listContentDesktop],
    [isCompact],
  );

  return (
    <FlatList
      data={schedules}
      style={styles.list}
      contentContainerStyle={contentContainerStyle}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={listHeader}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      testID="schedules-table"
    />
  );
}

function keyExtractor(schedule: ScheduleSummary): string {
  return schedule.id;
}

/**
 * Human label for the schedule, used in the delete confirmation. Mirrors the
 * row's title precedence (name → config title → first prompt line → fallback).
 */
function scheduleLabel(schedule: ScheduleSummary): string {
  const name = schedule.name?.trim();
  if (name) {
    return name;
  }
  if (schedule.target.type === "new-agent") {
    const configTitle = schedule.target.config.title?.trim();
    if (configTitle) {
      return configTitle;
    }
  }
  const firstPromptLine = schedule.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstPromptLine || "Untitled schedule";
}

// ---------------------------------------------------------------------------
// Per-row wrapper — owns local in-flight state and binds the table's mutation
// callbacks to this schedule. Local state keeps pending precise to the acting
// row even when several rows are acted on at once (the mutations hook exposes
// only a single global pending flag per action).
// ---------------------------------------------------------------------------

type ScheduleMutations = ReturnType<typeof useScheduleMutations>;

const NO_PENDING: ScheduleRowPending = {};

function SchedulesTableRow({
  schedule,
  mutations,
  onEditSchedule,
}: {
  schedule: ScheduleSummary;
  mutations: ScheduleMutations;
  onEditSchedule: (schedule: ScheduleSummary) => void;
}): ReactElement {
  const { id } = schedule;
  const [pending, setPending] = useState<ScheduleRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof ScheduleRowPending, action: () => Promise<void>): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch {
        // Mutations roll back their own optimistic cache writes on error and
        // re-fetch on settle; surfacing per-row toasts here is out of scope.
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const handleEdit = useCallback(() => {
    onEditSchedule(schedule);
  }, [onEditSchedule, schedule]);

  const handlePause = useCallback(() => {
    void runAction("pause", () => mutations.pauseSchedule(id));
  }, [runAction, mutations, id]);

  const handleResume = useCallback(() => {
    void runAction("resume", () => mutations.resumeSchedule(id));
  }, [runAction, mutations, id]);

  const handleRunNow = useCallback(() => {
    void runAction("runNow", () => mutations.runScheduleNow(id));
  }, [runAction, mutations, id]);

  const handleDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: "Delete schedule",
        message: `Delete "${scheduleLabel(schedule)}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction("delete", () => mutations.deleteSchedule(id));
    })();
  }, [runAction, mutations, id, schedule]);

  return (
    <ScheduleRow
      schedule={schedule}
      pending={pending}
      onEdit={handleEdit}
      onPause={handlePause}
      onResume={handleResume}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
    />
  );
}

const DESKTOP_MAX_WIDTH = 1040;

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingBottom: theme.spacing[6],
  },
  listContentCompact: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  // Center the table in a width-constrained column on desktop, with horizontal
  // page padding that matches the row's own padding so the columns line up.
  listContentDesktop: {
    width: "100%",
    maxWidth: DESKTOP_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
  },
}));
