import { type ReactNode, useCallback } from "react";
import { Import, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

function SidebarEmptyStateCard({
  testID,
  title,
  description,
  children,
}: {
  testID: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

/**
 * The two things the sidebar's workspace list says when it has no rows.
 *
 * Both are bodies, not screens: a list mode renders one where its groups would go, inside its own
 * scroll and below the section header it already owns. The header carries the display menu's
 * trigger, and an empty state that replaces the list rather than its body takes the header with
 * it — which is how filtering the last row away used to close the menu you were filtering from.
 */
export function SidebarFilterEmptyState() {
  const { t } = useTranslation();
  const clearLabelFilter = useSidebarViewStore((state) => state.clearLabelFilter);
  const setProjectVisibility = useSidebarViewStore((state) => state.setProjectVisibility);
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);
  // Clears every filter that can empty the list, not just the one that did. The card names no
  // filter, so a Clear that undid only one of two active filters would leave it on screen looking
  // like it had failed.
  const clearFilters = useCallback(() => {
    clearLabelFilter();
    clearProjectFilters();
    setProjectVisibility("all");
  }, [clearLabelFilter, clearProjectFilters, setProjectVisibility]);

  return (
    <SidebarEmptyStateCard
      testID="sidebar-filter-empty-state"
      title={t("sidebar.filterEmpty.title")}
      description={t("sidebar.filterEmpty.description")}
    >
      <Button variant="secondary" size="xs" onPress={clearFilters}>
        {t("sidebar.filterEmpty.clear")}
      </Button>
    </SidebarEmptyStateCard>
  );
}

export function SidebarProjectEmptyState({
  onAddProject,
  onImportSession,
}: {
  onAddProject?: () => void;
  onImportSession?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <SidebarEmptyStateCard
      testID="sidebar-project-empty-state"
      title={t("sidebar.project.empty.title")}
      description={t("sidebar.project.empty.description")}
    >
      <Button variant="secondary" size="xs" leftIcon={Plus} onPress={onAddProject}>
        {t("sidebar.actions.addProject")}
      </Button>
      <Button variant="outline" size="xs" leftIcon={Import} onPress={onImportSession}>
        {t("importSession.title")}
      </Button>
    </SidebarEmptyStateCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  copy: {
    gap: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
