import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { getPanelRegistration } from "@/panels/panel-registry";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { Theme } from "@/styles/theme";
import { usePanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-icon";

export type { WorkspaceTabPresentation };
export { WorkspaceTabIcon };

interface WorkspaceTabPresentationResolverProps {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  children: (presentation: WorkspaceTabPresentation) => ReactNode;
}

type WorkspaceTabPresentationResolverInnerProps = WorkspaceTabPresentationResolverProps & {
  registration: NonNullable<ReturnType<typeof getPanelRegistration>>;
};

export function WorkspaceTabPresentationResolver({
  tab,
  serverId,
  workspaceId,
  children,
}: WorkspaceTabPresentationResolverProps): ReactElement {
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.kind);
  invariant(registration, `No panel registration for kind: ${tab.kind}`);

  return (
    <WorkspaceTabPresentationResolverInner
      key={`${tab.key}:${tab.kind}`}
      registration={registration}
      tab={tab}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {children}
    </WorkspaceTabPresentationResolverInner>
  );
}

function WorkspaceTabPresentationResolverInner({
  registration,
  tab,
  serverId,
  workspaceId,
  children,
}: WorkspaceTabPresentationResolverInnerProps): ReactElement {
  const descriptor = registration.useDescriptor(tab.target as never, {
    serverId,
    workspaceId,
    tabId: tab.tabId,
  });
  const attributes = usePanelInstanceAttributes({ serverId, workspaceId, tabId: tab.tabId });

  const presentation = useMemo(
    () => ({
      key: tab.key,
      kind: tab.kind,
      label: descriptor.label,
      subtitle: descriptor.subtitle,
      tooltip: descriptor.tooltip,
      modified: attributes.modified,
      titleState: descriptor.titleState,
      icon: descriptor.icon,
      statusBucket: descriptor.statusBucket,
    }),
    [
      descriptor.icon,
      descriptor.label,
      descriptor.tooltip,
      descriptor.statusBucket,
      descriptor.subtitle,
      descriptor.titleState,
      tab.key,
      tab.kind,
      attributes.modified,
    ],
  );

  return <>{children(presentation)}</>;
}

interface WorkspaceTabOptionRowProps {
  presentation: WorkspaceTabPresentation;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  trailingAccessory?: ReactNode;
}

// Prefer withUnistyles mappings over uniProps — lucide forwards unknown props to
// SVG <path> on web, which logs React DOM warnings for `uniProps`.
const ThemedCheckIconMuted = withUnistyles(Check, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function WorkspaceTabOptionRow({
  presentation,
  selected,
  active,
  onPress,
  trailingAccessory,
}: WorkspaceTabOptionRowProps): ReactElement {
  const { t } = useTranslation();
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionMainPressable,
      (Boolean(hovered) || pressed || active) && styles.optionRowActive,
    ],
    [active],
  );
  const optionRowStyle = useMemo(
    () => [styles.optionRow, active && styles.optionRowActive],
    [active],
  );
  return (
    <View style={optionRowStyle}>
      <Pressable onPress={onPress} style={pressableStyle}>
        <View style={styles.optionLeadingSlot}>
          <WorkspaceTabIcon presentation={presentation} active={selected || active} />
        </View>
        <View style={styles.optionContent}>
          <Text numberOfLines={1} style={styles.optionLabel}>
            {presentation.titleState === "loading"
              ? t("workspace.tabs.loading")
              : presentation.label}
          </Text>
        </View>
      </Pressable>
      {presentation.modified ? (
        <View style={styles.optionModifiedDot} accessibilityLabel={t("workspace.tabs.modified")} />
      ) : null}
      {selected ? (
        <View style={styles.optionTrailingSlot}>
          <ThemedCheckIconMuted size={16} />
        </View>
      ) : null}
      {trailingAccessory ? (
        <View style={styles.optionTrailingAccessorySlot}>{trailingAccessory}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: 0,
    marginHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
  optionMainPressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  optionRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  optionLeadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionContent: {
    flex: 1,
    flexShrink: 1,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  optionTrailingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionModifiedDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  optionTrailingAccessorySlot: {
    alignItems: "center",
    justifyContent: "center",
  },
}));
