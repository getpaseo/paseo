import { useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { SyncedLoader } from "@/components/synced-loader";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { getPanelRegistration } from "@/panels/panel-registry";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor, isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";

export interface WorkspaceTabPresentation {
  key: string;
  kind: WorkspaceTabDescriptor["kind"];
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  icon: React.ComponentType<{ size: number; color: string }>;
  statusBucket: SidebarStateBucket | null;
}

const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = -2;
const EMPHASIZED_STATUS_DOT_OFFSET = -3;

type WorkspaceTabPresentationResolverProps = {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  children: (presentation: WorkspaceTabPresentation) => ReactNode;
};

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
  });

  const presentation = useMemo(
    () => ({
      key: tab.key,
      kind: tab.kind,
      label: descriptor.label,
      subtitle: descriptor.subtitle,
      titleState: descriptor.titleState,
      icon: descriptor.icon,
      statusBucket: descriptor.statusBucket,
    }),
    [
      descriptor.icon,
      descriptor.label,
      descriptor.statusBucket,
      descriptor.subtitle,
      descriptor.titleState,
      tab.key,
      tab.kind,
    ],
  );

  return <>{children(presentation)}</>;
}

type WorkspaceTabIconProps = {
  presentation: WorkspaceTabPresentation;
  active?: boolean;
  size?: number;
  statusDotBorderColor?: string;
};

export function WorkspaceTabIcon({
  presentation,
  active = false,
  size = 14,
  statusDotBorderColor,
}: WorkspaceTabIconProps): ReactElement {
  const { theme } = useUnistyles();
  const iconColor = active ? theme.colors.foreground : theme.colors.foregroundMuted;
  const statusDotColor =
    presentation.statusBucket === null
      ? null
      : getStatusDotColor({
          theme,
          bucket: presentation.statusBucket,
          showDoneAsInactive: false,
        });
  const statusDotSize = isEmphasizedStatusDotBucket(presentation.statusBucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;
  const shouldShowLoader = shouldRenderSyncedStatusLoader({
    bucket: presentation.statusBucket,
  });
  const Icon = presentation.icon;

  if (shouldShowLoader) {
    return (
      <View style={[styles.agentIconWrapper, { width: size, height: size }]}>
        <SyncedLoader
          size={size - 1}
          color={
            theme.colorScheme === "light"
              ? theme.colors.palette.amber[700]
              : theme.colors.palette.amber[500]
          }
        />
      </View>
    );
  }

  return (
    <View style={[styles.agentIconWrapper, { width: size, height: size }]}>
      <Icon size={size} color={iconColor} />
      {statusDotColor ? (
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor: statusDotColor,
              borderColor: statusDotBorderColor ?? theme.colors.surface0,
              width: statusDotSize,
              height: statusDotSize,
              right: statusDotOffset,
              bottom: statusDotOffset,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

type WorkspaceTabOptionRowProps = {
  presentation: WorkspaceTabPresentation;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  trailingAccessory?: ReactNode;
};

export function WorkspaceTabOptionRow({
  presentation,
  selected,
  active,
  onPress,
  trailingAccessory,
}: WorkspaceTabOptionRowProps): ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.optionRow, active && styles.optionRowActive]}>
      <Pressable
        onPress={onPress}
        style={({ hovered = false, pressed }) => [
          styles.optionMainPressable,
          (hovered || pressed || active) && styles.optionRowActive,
        ]}
      >
        <View style={styles.optionLeadingSlot}>
          <WorkspaceTabIcon presentation={presentation} active={selected || active} />
        </View>
        <View style={styles.optionContent}>
          <Text numberOfLines={1} style={styles.optionLabel}>
            {presentation.titleState === "loading" ? "Loading..." : presentation.label}
          </Text>
        </View>
      </Pressable>
      {selected ? (
        <View style={styles.optionTrailingSlot}>
          <Check size={16} color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      {trailingAccessory ? (
        <View style={styles.optionTrailingAccessorySlot}>{trailingAccessory}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: DEFAULT_STATUS_DOT_SIZE,
    height: DEFAULT_STATUS_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
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
  optionTrailingAccessorySlot: {
    alignItems: "center",
    justifyContent: "center",
  },
}));
