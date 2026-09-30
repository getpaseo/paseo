import { router, usePathname } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PandaStatus } from "@/components/panda-status";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { deriveLeitstandMood, type InboxItem, type PandaMood } from "@/leitstand/inbox-model";
import { StatusGlyph, glyphForInboxKind } from "@/leitstand/status-glyph";
import { AgeText } from "@/leitstand/tags";
import {
  useLeitstandSchedules,
  useLeitstandSessions,
  useSnoozableInbox,
} from "@/leitstand/use-leitstand";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildDashboardRoute, buildSchedulesRoute, isLeitstandPathname } from "@/utils/host-routes";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { projectSidebarInbox, type SidebarInboxProjection } from "./sidebar-leiste-model";
import { DISPLAY_FONT_DATASET, MONO_FONT_DATASET } from "@/styles/font-dataset";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

interface SidebarLeisteHeaderProps {
  /** Wrapper for the Leitstand button and the nav rows; the sidebar owns its divider. */
  style?: StyleProp<ViewStyle>;
  onBeforeNavigate?: () => void;
  /** Room kept free on the right of the Leitstand button, for the mobile close button. */
  trailingInset?: number;
}

/**
 * The head of the Leiste: the Leitstand button, the sidebar items, and "Needs you". This is what
 * the Leitstand shrinks to while a session is open, so it reads the same inbox and snoozes.
 */
export function SidebarLeisteHeader({
  style,
  onBeforeNavigate,
  trailingInset = 0,
}: SidebarLeisteHeaderProps) {
  // useLeitstandInbox without the running count the panda's mood needs; same hooks, one pass.
  const { sessions, runningAgentCount } = useLeitstandSessions();
  const schedules = useLeitstandSchedules(sessions);
  const inbox = useSnoozableInbox(sessions, schedules);
  const mood = deriveLeitstandMood({ items: inbox.items, runningAgentCount });
  const isLeitstandOpen = isLeitstandPathname(usePathname());
  const projection = projectSidebarInbox({ items: inbox.items, isLeitstandOpen });

  const openLeitstand = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildDashboardRoute());
  }, [onBeforeNavigate]);

  // A stable element, so a live inbox update does not re-render the nav rows.
  const navRows = useMemo(
    () => <SidebarNavRows onBeforeNavigate={onBeforeNavigate} />,
    [onBeforeNavigate],
  );

  return (
    <>
      <View style={style}>
        <SidebarLeitstandButton
          mood={mood}
          isActive={isLeitstandOpen}
          onPress={openLeitstand}
          trailingInset={trailingInset}
        />
        {navRows}
      </View>
      {projection ? (
        <SidebarInboxSection
          projection={projection}
          count={inbox.items.length}
          onBeforeNavigate={onBeforeNavigate}
          onOpenLeitstand={openLeitstand}
        />
      ) : null}
    </>
  );
}

const SidebarLeitstandButton = memo(function SidebarLeitstandButton({
  mood,
  isActive,
  onPress,
  trailingInset,
}: {
  mood: PandaMood;
  isActive: boolean;
  onPress: () => void;
  trailingInset: number;
}) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys("toggle-leitstand");
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const containerStyle = useMemo(
    () => [styles.brandContainer, trailingInset > 0 && { marginRight: trailingInset }],
    [trailingInset],
  );
  const buttonStyle = useCallback(
    ({ hovered }: HoverState) => [
      styles.brand,
      Boolean(hovered) && !isActive && styles.rowHovered,
      isActive && styles.rowSelected,
    ],
    [isActive],
  );

  return (
    <View style={containerStyle}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.leitstand.open")}
        accessibilityState={accessibilityState}
        style={buttonStyle}
        testID="sidebar-leitstand"
      >
        {({ hovered }: HoverState) => (
          <>
            <View
              style={isActive ? [styles.pandaTile, styles.pandaTileSelected] : styles.pandaTile}
            >
              <PandaStatus mood={mood} size="small" testID={`sidebar-leitstand-panda-${mood}`} />
            </View>
            <View style={styles.brandText}>
              <Text
                dataSet={DISPLAY_FONT_DATASET}
                style={[styles.brandName, isActive && styles.textSelected]}
                numberOfLines={1}
              >
                PandaOS
              </Text>
              <Text style={[styles.brandSub, isActive && styles.textSelected]} numberOfLines={1}>
                {t("leitstand.title")}
              </Text>
            </View>
            {shortcutKeys && Boolean(hovered) && !isActive ? (
              <Shortcut chord={shortcutKeys} style={styles.shortcut} />
            ) : null}
          </>
        )}
      </Pressable>
    </View>
  );
});

function SidebarInboxSection({
  projection,
  count,
  onBeforeNavigate,
  onOpenLeitstand,
}: {
  projection: SidebarInboxProjection;
  count: number;
  onBeforeNavigate?: () => void;
  onOpenLeitstand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.inbox} testID="sidebar-inbox">
      <View style={styles.inboxHeader}>
        <Text style={styles.inboxTitle}>{t("leitstand.inbox.title")}</Text>
        <Text dataSet={MONO_FONT_DATASET} style={styles.inboxCount} testID="sidebar-inbox-count">
          {count}
        </Text>
      </View>
      {projection.rows.map((item) => (
        <SidebarInboxRow key={item.id} item={item} onBeforeNavigate={onBeforeNavigate} />
      ))}
      {projection.hiddenCount > 0 ? (
        <Pressable
          onPress={onOpenLeitstand}
          accessibilityRole="button"
          style={inboxRowStyle}
          testID="sidebar-inbox-more"
        >
          <Text style={styles.moreText} numberOfLines={1}>
            {t("sidebar.inbox.more", { count: projection.hiddenCount })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const KIND_LABEL_KEY = {
  permission: "leitstand.inbox.kinds.permission",
  question: "leitstand.inbox.kinds.question",
  agent_error: "leitstand.inbox.kinds.agentError",
  schedule_error: "leitstand.inbox.kinds.scheduleError",
  checks_failed: "leitstand.inbox.kinds.checksFailed",
  merge_ready: "leitstand.inbox.kinds.mergeReady",
  finished: "leitstand.inbox.kinds.finished",
} as const satisfies Record<InboxItem["kind"], string>;

/** Same landing as the Leitstand's primary action: the agent that asked or failed, if known. */
function sessionTarget(item: InboxItem): WorkspaceTabTarget | undefined {
  if (item.kind === "permission") return { kind: "agent", agentId: item.agentId };
  if (item.kind === "agent_error" && item.agentId) return { kind: "agent", agentId: item.agentId };
  return undefined;
}

function inboxRowStyle({ hovered }: HoverState) {
  return [styles.inboxRow, Boolean(hovered) && styles.rowHovered];
}

const SidebarInboxRow = memo(function SidebarInboxRow({
  item,
  onBeforeNavigate,
}: {
  item: InboxItem;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    if (item.workspaceId === null) {
      router.push(buildSchedulesRoute());
      return;
    }
    navigateToWorkspace({
      serverId: item.serverId,
      workspaceId: item.workspaceId,
      target: sessionTarget(item),
    });
  }, [item, onBeforeNavigate]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${t(KIND_LABEL_KEY[item.kind])}: ${item.title}`}
      style={inboxRowStyle}
      testID={`sidebar-inbox-item-${item.id}`}
    >
      <StatusGlyph name={glyphForInboxKind(item.kind)} size={12} />
      <Text style={styles.inboxRowTitle} numberOfLines={1}>
        {item.title}
      </Text>
      <AgeText date={item.since} />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  brandContainer: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    userSelect: "none",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.base,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // Ink fill, as the settings navigation marks its current page.
  rowSelected: {
    backgroundColor: theme.colors.foreground,
  },
  // The panda's fur colours are fixed, so on an ink fill it keeps a patch of paper to stand on.
  pandaTile: {
    borderRadius: theme.borderRadius.sm,
    padding: 2,
  },
  pandaTileSelected: {
    backgroundColor: theme.colors.surface0,
  },
  brandText: {
    flex: 1,
    minWidth: 0,
  },
  brandName: {
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize.xl,
    lineHeight: theme.fontSize.xl + 2,
    color: theme.colors.foreground,
  },
  brandSub: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.foregroundMuted,
  },
  textSelected: {
    color: theme.colors.surface0,
  },
  shortcut: {
    marginLeft: "auto",
  },
  inbox: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inboxHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  // Amber means "waits on you" everywhere; this heading is exactly that.
  inboxTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.statusWarning,
  },
  inboxCount: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    color: theme.colors.statusWarning,
  },
  inboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 30,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    userSelect: "none",
  },
  inboxRowTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  moreText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
