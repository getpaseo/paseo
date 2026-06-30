import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScheduleRow, type ScheduleRowPending } from "@/components/schedules/schedule-row";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveScheduleTitle } from "@/utils/schedule-format";
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
 * The schedules list: a single settings-style card of rows in a centered,
 * width-constrained reading column, matching the projects list. Owns row-level
 * actions (pause/resume/run/delete via the mutations hook + a destructive
 * confirm for delete) and delegates editing to the parent.
 */
export function SchedulesTable({
  serverId,
  schedules,
  onEditSchedule,
}: SchedulesTableProps): ReactElement {
  const mutations = useScheduleMutations({ serverId });

  return (
    <View style={styles.listContent} testID="schedules-table">
      <View style={settingsStyles.card}>
        {schedules.map((schedule, index) => (
          <SchedulesTableRow
            key={schedule.id}
            schedule={schedule}
            isFirst={index === 0}
            mutations={mutations}
            onEditSchedule={onEditSchedule}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-row wrapper owns local in-flight state and binds the table's mutation
// callbacks to this schedule. Local state keeps pending precise to the acting
// row even when several rows are acted on at once (the mutations hook exposes
// only a single global pending flag per action).
// ---------------------------------------------------------------------------

type ScheduleMutations = ReturnType<typeof useScheduleMutations>;

const NO_PENDING: ScheduleRowPending = {};

function SchedulesTableRow({
  schedule,
  isFirst,
  mutations,
  onEditSchedule,
}: {
  schedule: ScheduleSummary;
  isFirst: boolean;
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
        message: `Delete "${resolveScheduleTitle(schedule)}"? This cannot be undone.`,
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
      isFirst={isFirst}
      pending={pending}
      onEdit={handleEdit}
      onPause={handlePause}
      onResume={handleResume}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
    />
  );
}

const CONTENT_MAX_WIDTH = 720;

const styles = StyleSheet.create((theme) => ({
  // Center the card in a readable column, matching settings and projects.
  listContent: {
    width: "100%",
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
  },
}));
