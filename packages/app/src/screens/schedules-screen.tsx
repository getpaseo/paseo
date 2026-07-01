import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useSchedules, type ScheduleHostSection } from "@/hooks/use-schedules";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

type FormState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; serverId: string; schedule: ScheduleSummary };

export function SchedulesScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SchedulesScreenContent />;
}

function SchedulesScreenContent(): ReactElement {
  const { sections, isLoading, isError, error, refetch } = useSchedules();
  const [form, setForm] = useState<FormState>({ mode: "closed" });

  const openCreate = useCallback(() => {
    setForm({ mode: "create" });
  }, []);

  const openEdit = useCallback((serverId: string, schedule: ScheduleSummary) => {
    setForm({ mode: "edit", serverId, schedule });
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
        sections={sections}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        onCreate={openCreate}
        onEdit={openEdit}
      />
      <ScheduleFormSheet
        serverId={form.mode === "edit" ? form.serverId : undefined}
        visible={form.mode === "create" || form.mode === "edit"}
        onClose={closeForm}
        mode={form.mode === "edit" ? "edit" : "create"}
        schedule={form.mode === "edit" ? form.schedule : undefined}
      />
    </View>
  );
}

function SchedulesBody({
  sections,
  isLoading,
  isError,
  error,
  onRetry,
  onCreate,
  onEdit,
}: {
  sections: ScheduleHostSection[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (serverId: string, schedule: ScheduleSummary) => void;
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

  if (sections.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>No schedules yet</Text>
        <Button leftIcon={Plus} onPress={onCreate} testID="schedules-empty-new">
          New schedule
        </Button>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      testID="schedules-sections"
    >
      {sections.map((section) => (
        <ScheduleHostSectionView key={section.serverId} section={section} onEdit={onEdit} />
      ))}
    </ScrollView>
  );
}

function ScheduleHostSectionView({
  section,
  onEdit,
}: {
  section: ScheduleHostSection;
  onEdit: (serverId: string, schedule: ScheduleSummary) => void;
}): ReactElement {
  const handleEdit = useCallback(
    (schedule: ScheduleSummary) => {
      onEdit(section.serverId, schedule);
    },
    [onEdit, section.serverId],
  );
  const emptyMessage = section.isOnline ? "No schedules" : "Host offline";

  return (
    <View style={styles.section} testID={`schedules-section-${section.serverId}`}>
      <Text style={styles.sectionTitle} testID={`schedules-section-title-${section.serverId}`}>
        {section.serverName}
      </Text>
      {section.error ? <Text style={styles.sectionError}>{section.error}</Text> : null}
      {section.schedules.length > 0 ? (
        <SchedulesTable
          serverId={section.serverId}
          schedules={section.schedules}
          onEditSchedule={handleEdit}
        />
      ) : null}
      {section.schedules.length === 0 && !section.error ? (
        <View style={styles.sectionEmpty}>
          <Text style={styles.sectionEmptyText}>{emptyMessage}</Text>
        </View>
      ) : null}
    </View>
  );
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
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sectionError: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  sectionEmpty: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  sectionEmptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without
  // useUnistyles (banned in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
