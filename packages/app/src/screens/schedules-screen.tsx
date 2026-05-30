import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useSchedules } from "@/hooks/use-schedules";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; schedule: ScheduleSummary };

export function SchedulesScreen({ serverId }: { serverId: string }): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SchedulesScreenContent serverId={serverId} />;
}

function SchedulesScreenContent({ serverId }: { serverId: string }): ReactElement {
  const { schedules, isLoading, isError, error, refetch } = useSchedules({ serverId });
  const [form, setForm] = useState<FormState>({ mode: "closed" });

  const openCreate = useCallback(() => {
    setForm({ mode: "create" });
  }, []);

  const openEdit = useCallback((schedule: ScheduleSummary) => {
    setForm({ mode: "edit", schedule });
  }, []);

  const closeForm = useCallback(() => {
    setForm({ mode: "closed" });
  }, []);

  const headerAction = useMemo(
    () => (
      <Button leftIcon={Plus} onPress={openCreate} size="sm" testID="schedules-new">
        New schedule
      </Button>
    ),
    [openCreate],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Schedules" rightContent={headerAction} />
      <SchedulesBody
        serverId={serverId}
        schedules={schedules}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
      />
      <ScheduleFormSheet
        serverId={serverId}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        schedule={form.mode === "edit" ? form.schedule : undefined}
      />
    </View>
  );
}

function SchedulesBody({
  serverId,
  schedules,
  isLoading,
  isError,
  error,
  onRetry,
  onCreate,
  onEdit,
}: {
  serverId: string;
  schedules: ScheduleSummary[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (schedule: ScheduleSummary) => void;
}): ReactElement {
  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{error?.message ?? "Could not load schedules"}</Text>
        <Button variant="ghost" onPress={onRetry} testID="schedules-retry">
          Retry
        </Button>
      </View>
    );
  }

  if (schedules.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>No schedules yet</Text>
        <Button leftIcon={Plus} onPress={onCreate} testID="schedules-empty-new">
          New schedule
        </Button>
      </View>
    );
  }

  return <SchedulesTable serverId={serverId} schedules={schedules} onEditSchedule={onEdit} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner — keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
