import { memo, useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { AtSign, Hash, Lock, Search } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { ChatChannel } from "@/api/chat";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isNative } from "@/constants/platform";
import { Avatar } from "./avatar";

function Tip({
  label,
  side = "right",
  children,
}: {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align="center" offset={8}>
        <Text style={tipStyles.text}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const tipStyles = StyleSheet.create((theme) => ({
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));

export interface DmEntry {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  channel: ChatChannel | null;
  online?: boolean;
}

interface ChannelSidebarProps {
  channels: ChatChannel[];
  dmEntries: DmEntry[];
  selectedChannelId: string | null;
  mentionsCount?: number;
  onSelectChannel: (id: string) => void;
  onOpenDm: (entry: DmEntry) => void;
  onCreateChannel?: () => void;
  onOpenSearch?: () => void;
  onOpenMentions?: () => void;
  /** When true, render as a narrow icon-only rail with tooltips. */
  collapsed?: boolean;
}

export function ChannelSidebar({
  channels,
  dmEntries,
  selectedChannelId,
  mentionsCount,
  onSelectChannel,
  onOpenDm,
  onCreateChannel,
  onOpenSearch,
  onOpenMentions,
  collapsed,
}: ChannelSidebarProps) {
  const { theme } = useUnistyles();
  const sorted = useMemo(
    () =>
      [...channels].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "public" ? -1 : 1;
        return (a.name ?? "").localeCompare(b.name ?? "");
      }),
    [channels],
  );
  // Existing DMs bubble up (sorted by recency); new members alphabetical.
  const sortedDmEntries = useMemo(() => {
    const withChannel = dmEntries
      .filter((e) => e.channel)
      .sort((a, b) =>
        (b.channel?.createdAt ?? "").localeCompare(a.channel?.createdAt ?? ""),
      );
    const without = dmEntries
      .filter((e) => !e.channel)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...withChannel, ...without];
  }, [dmEntries]);

  if (collapsed) {
    return (
      <CollapsedRail
        channels={sorted}
        dmEntries={sortedDmEntries}
        selectedChannelId={selectedChannelId}
        mentionsCount={mentionsCount}
        onSelectChannel={onSelectChannel}
        onOpenDm={onOpenDm}
        onOpenSearch={onOpenSearch}
        onOpenMentions={onOpenMentions}
      />
    );
  }

  return (
    <View style={styles.container}>
      {(onOpenSearch || onOpenMentions) && (
        <View style={styles.quickRow}>
          {onOpenSearch ? (
            <Pressable
              onPress={onOpenSearch}
              style={styles.quickBtn}
              accessibilityRole="button"
              accessibilityLabel="Search messages"
            >
              <Search size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.quickLabel}>Search</Text>
            </Pressable>
          ) : null}
          {onOpenMentions ? (
            <Pressable
              onPress={onOpenMentions}
              style={styles.quickBtn}
              accessibilityRole="button"
              accessibilityLabel="View mentions"
            >
              <AtSign size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.quickLabel}>Mentions</Text>
              {mentionsCount && mentionsCount > 0 ? (
                <View style={styles.quickBadge}>
                  <Text style={styles.quickBadgeText}>
                    {mentionsCount > 99 ? "99+" : mentionsCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ) : null}
        </View>
      )}
      <Section title="Channels" onAction={onCreateChannel} actionLabel="+">
        {sorted.length === 0 ? (
          <Empty>No channels yet</Empty>
        ) : (
          sorted.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              selected={selectedChannelId === c.id}
              onSelect={onSelectChannel}
            />
          ))
        )}
      </Section>
      <Section title="Direct Messages">
        {sortedDmEntries.length === 0 ? (
          <Empty>No members yet</Empty>
        ) : (
          sortedDmEntries.map((entry) => (
            <DmRow
              key={entry.userId}
              entry={entry}
              selected={
                !!entry.channel && selectedChannelId === entry.channel.id
              }
              onPress={() => onOpenDm(entry)}
            />
          ))
        )}
      </Section>
    </View>
  );
}

function Section({
  title,
  children,
  onAction,
  actionLabel,
}: {
  title: string;
  children: React.ReactNode;
  onAction?: () => void;
  actionLabel?: string;
}) {
  return (
    <View style={styles.section}>
      <Pressable style={styles.sectionHeader}>
        {({ hovered = false }) => {
          const showAction = hovered || isNative;
          return (
            <>
              <Text style={styles.sectionTitle}>{title}</Text>
              {onAction && actionLabel && showAction ? (
                <Pressable
                  onPress={onAction}
                  style={styles.sectionAction}
                  accessibilityRole="button"
                >
                  <Text style={styles.sectionActionText}>{actionLabel}</Text>
                </Pressable>
              ) : null}
            </>
          );
        }}
      </Pressable>
      {children}
    </View>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>;
}

function CollapsedRail({
  channels,
  dmEntries,
  selectedChannelId,
  mentionsCount,
  onSelectChannel,
  onOpenDm,
  onOpenSearch,
  onOpenMentions,
}: {
  channels: ChatChannel[];
  dmEntries: DmEntry[];
  selectedChannelId: string | null;
  mentionsCount?: number;
  onSelectChannel: (id: string) => void;
  onOpenDm: (entry: DmEntry) => void;
  onOpenSearch?: () => void;
  onOpenMentions?: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.railContainer}>
      {onOpenSearch ? (
        <RailIconBtn
          label="Search"
          onPress={onOpenSearch}
          icon={<Search size={15} color={theme.colors.foregroundMuted} />}
        />
      ) : null}
      {onOpenMentions ? (
        <RailIconBtn
          label="Mentions"
          onPress={onOpenMentions}
          badge={mentionsCount && mentionsCount > 0 ? mentionsCount : undefined}
          icon={<AtSign size={15} color={theme.colors.foregroundMuted} />}
        />
      ) : null}
      <View style={styles.railDivider} />
      {channels.map((c) => {
        const selected = c.id === selectedChannelId;
        const unread = (c.unreadCount ?? 0) > 0 && !selected;
        const Icon = c.kind === "private" ? Lock : Hash;
        return (
          <RailIconBtn
            key={c.id}
            label={c.name ?? "channel"}
            selected={selected}
            unread={unread}
            onPress={() => onSelectChannel(c.id)}
            icon={
              <Icon
                size={15}
                color={
                  selected || unread
                    ? theme.colors.foreground
                    : theme.colors.foregroundMuted
                }
              />
            }
          />
        );
      })}
      {dmEntries.length > 0 ? <View style={styles.railDivider} /> : null}
      {dmEntries.map((entry) => {
        const selected =
          !!entry.channel && selectedChannelId === entry.channel.id;
        const unread = (entry.channel?.unreadCount ?? 0) > 0 && !selected;
        return (
          <RailAvatarBtn
            key={entry.userId}
            entry={entry}
            selected={selected}
            unread={unread}
            onPress={() => onOpenDm(entry)}
          />
        );
      })}
    </View>
  );
}

function RailIconBtn({
  label,
  onPress,
  icon,
  selected,
  unread,
  badge,
}: {
  label: string;
  onPress: () => void;
  icon: React.ReactNode;
  selected?: boolean;
  unread?: boolean;
  badge?: number;
}) {
  return (
    <Tip label={label}>
      <Pressable
        onPress={onPress}
        style={[styles.railBtn, selected && styles.railBtnSelected]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {icon}
        {unread ? <View style={styles.railUnreadDot} /> : null}
        {badge ? (
          <View style={styles.railBadge}>
            <Text style={styles.railBadgeText}>
              {badge > 99 ? "99+" : badge}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Tip>
  );
}

function RailAvatarBtn({
  entry,
  selected,
  unread,
  onPress,
}: {
  entry: DmEntry;
  selected: boolean;
  unread: boolean;
  onPress: () => void;
}) {
  return (
    <Tip label={entry.name}>
      <Pressable
        onPress={onPress}
        style={[styles.railBtn, selected && styles.railBtnSelected]}
        accessibilityRole="button"
        accessibilityLabel={entry.name}
      >
        <Avatar
          name={entry.name}
          imageUrl={entry.avatarUrl ?? null}
          size={24}
          online={entry.online}
        />
        {unread ? <View style={styles.railUnreadDot} /> : null}
      </Pressable>
    </Tip>
  );
}

const DmRow = memo(function DmRow({
  entry,
  selected,
  onPress,
}: {
  entry: DmEntry;
  selected: boolean;
  onPress: () => void;
}) {
  const channel = entry.channel;
  const unread = channel?.unreadCount ?? 0;
  const hasMention = !!channel?.hasMention;
  const muted = !!channel?.muted;
  const unreadLook = !selected && unread > 0 && (!muted || hasMention);
  const showNumericBadge = unread > 0 && !selected && !muted;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, selected && styles.rowSelected]}
      accessibilityRole="button"
      accessibilityLabel={`Direct message with ${entry.name}`}
    >
      <Avatar
        name={entry.name}
        imageUrl={entry.avatarUrl ?? null}
        size={20}
        online={entry.online}
      />
      <Text
        style={[
          styles.rowLabel,
          selected && styles.rowLabelSelected,
          unreadLook && styles.rowLabelUnread,
          muted && !hasMention && styles.rowLabelMuted,
        ]}
        numberOfLines={1}
      >
        {entry.name}
      </Text>
      {hasMention && !selected ? (
        <View style={[styles.badge, styles.badgeMention]}>
          <Text style={styles.badgeText}>@</Text>
        </View>
      ) : showNumericBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {unread > 99 ? "99+" : unread}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const ChannelRow = memo(function ChannelRow({
  channel,
  selected,
  onSelect,
}: {
  channel: ChatChannel;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { theme } = useUnistyles();
  const Icon = channel.kind === "private" ? Lock : Hash;
  const label = channel.name ?? "—";
  const unread = channel.unreadCount ?? 0;
  const hasMention = !!channel.hasMention;
  const muted = !!channel.muted;
  // Muted channels hide the numeric badge but still surface @mentions.
  const unreadLook = !selected && unread > 0 && (!muted || hasMention);
  const showNumericBadge = unread > 0 && !selected && !muted;

  return (
    <Pressable
      onPress={() => onSelect(channel.id)}
      style={[styles.row, selected && styles.rowSelected]}
      accessibilityRole="button"
    >
      <Icon
        size={14}
        color={
          selected
            ? theme.colors.foreground
            : unreadLook
              ? theme.colors.foreground
              : theme.colors.foregroundMuted
        }
      />
      <Text
        style={[
          styles.rowLabel,
          selected && styles.rowLabelSelected,
          unreadLook && styles.rowLabelUnread,
          muted && !hasMention && styles.rowLabelMuted,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {hasMention && !selected ? (
        <View style={[styles.badge, styles.badgeMention]}>
          <Text style={styles.badgeText}>@</Text>
        </View>
      ) : showNumericBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {unread > 99 ? "99+" : unread}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    gap: theme.spacing[3],
  },
  section: { gap: theme.spacing[1] },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  sectionAction: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: 4,
  },
  sectionActionText: {
    fontSize: 16,
    color: theme.colors.foregroundMuted,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 6,
    borderRadius: 4,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface1,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.foregroundMuted,
  },
  rowLabelSelected: {
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  rowLabelUnread: {
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  rowLabelMuted: {
    opacity: 0.6,
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeMention: {
    backgroundColor: "#e53935",
  },
  badgeText: {
    fontSize: 11,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  empty: {
    paddingHorizontal: theme.spacing[2],
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  quickRow: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  quickBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface1,
  },
  quickLabel: {
    flex: 1,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
  quickBadge: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 9,
    backgroundColor: "#e53935",
    alignItems: "center",
    justifyContent: "center",
  },
  quickBadgeText: {
    fontSize: 10,
    color: "#ffffff",
    fontWeight: "600",
  },
  railContainer: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: 4,
    backgroundColor: theme.colors.surface0,
  },
  railBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    position: "relative",
  },
  railBtnSelected: {
    backgroundColor: theme.colors.surface1,
  },
  railDivider: {
    width: 20,
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: 4,
  },
  railUnreadDot: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.brandMagenta,
  },
  railBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    backgroundColor: "#e53935",
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeText: {
    fontSize: 9,
    color: "#ffffff",
    fontWeight: "700",
  },
}));
