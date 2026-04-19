import { useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { UserMinus, UserPlus } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import {
  useAddChannelMemberMutation,
  useRemoveChannelMemberMutation,
  useChannelMembersQuery,
  useUpdateChannelPrefsMutation,
} from "@/hooks/chat/use-chat-queries";
import { useOrgMembersQuery } from "@/hooks/chat/use-org-members";
import type { ChatChannel } from "@/api/chat";
import type { ChatPresence } from "@/stores/chat-store";
import { Avatar } from "./avatar";

interface ChannelMembersModalProps {
  visible: boolean;
  channel: ChatChannel;
  sessionToken: string | null;
  currentUserId: string | null;
  /** Whether the current user can invite / remove others in this channel. */
  canManage: boolean;
  presenceByUser: Record<string, ChatPresence>;
  onClose: () => void;
}

export function ChannelMembersModal({
  visible,
  channel,
  sessionToken,
  currentUserId,
  canManage,
  presenceByUser,
  onClose,
}: ChannelMembersModalProps) {
  const { theme } = useUnistyles();
  const membersQuery = useChannelMembersQuery(channel.id, sessionToken);
  const orgMembersQuery = useOrgMembersQuery(channel.orgId, sessionToken);
  const addMutation = useAddChannelMemberMutation(sessionToken);
  const removeMutation = useRemoveChannelMemberMutation(sessionToken);
  const prefsMutation = useUpdateChannelPrefsMutation(sessionToken);
  const currentPref = channel.notifyPref ?? "all";
  const currentMuted = !!channel.muted;
  const [query, setQuery] = useState("");

  const currentIds = useMemo(
    () => new Set((membersQuery.data ?? []).map((m) => m.userId)),
    [membersQuery.data],
  );

  const invitables = useMemo(() => {
    const list = (orgMembersQuery.data ?? []).filter(
      (m) => m.user && !currentIds.has(m.userId),
    );
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((m) => {
      const name = m.user?.name.toLowerCase() ?? "";
      const email = m.user?.email.toLowerCase() ?? "";
      return name.includes(q) || email.includes(q);
    });
  }, [orgMembersQuery.data, currentIds, query]);

  const current = useMemo(
    () =>
      [...(membersQuery.data ?? [])].sort((a, b) => {
        const aOnline = !!presenceByUser[a.userId];
        const bOnline = !!presenceByUser[b.userId];
        if (aOnline !== bOnline) return aOnline ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [membersQuery.data, presenceByUser],
  );

  return (
    <AdaptiveModalSheet
      title={`${current.length} member${current.length === 1 ? "" : "s"}`}
      visible={visible}
      onClose={onClose}
    >
      <View style={styles.body}>
        {channel.isMember ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Notifications</Text>
            {(["all", "mentions", "nothing"] as const).map((p) => (
              <Pressable
                key={p}
                onPress={() =>
                  prefsMutation.mutate({
                    channelId: channel.id,
                    orgId: channel.orgId,
                    pref: p,
                  })
                }
                style={styles.prefRow}
                accessibilityRole="radio"
                accessibilityState={{ selected: currentPref === p }}
              >
                <View
                  style={[
                    styles.radio,
                    currentPref === p && styles.radioActive,
                  ]}
                />
                <View style={styles.prefTextWrap}>
                  <Text style={styles.prefTitle}>{prefLabel(p)}</Text>
                  <Text style={styles.prefHint}>{prefDescription(p)}</Text>
                </View>
              </Pressable>
            ))}
            <View style={styles.muteRow}>
              <Text style={styles.prefTitle}>Mute channel</Text>
              <Switch
                value={currentMuted}
                onValueChange={(next) =>
                  prefsMutation.mutate({
                    channelId: channel.id,
                    orgId: channel.orgId,
                    muted: next,
                  })
                }
              />
            </View>
          </View>
        ) : null}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>In this channel</Text>
          {current.map((m) => {
            const isSelf = m.userId === currentUserId;
            const canRemove = canManage && !isSelf;
            return (
              <View key={m.userId} style={styles.row}>
                <Avatar
                  name={m.name}
                  imageUrl={m.image}
                  size={32}
                  online={!!presenceByUser[m.userId]}
                />
                <View style={styles.rowBody}>
                  <Text style={styles.rowName}>
                    {m.name} {isSelf ? <Text style={styles.rowYou}>(you)</Text> : null}
                  </Text>
                  <Text style={styles.rowMeta}>{m.role}</Text>
                </View>
                {canRemove ? (
                  <Pressable
                    onPress={() =>
                      removeMutation.mutate({
                        channelId: channel.id,
                        userId: m.userId,
                      })
                    }
                    style={styles.rowAction}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${m.name}`}
                  >
                    <UserMinus size={16} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>

        {canManage && channel.kind !== "dm" ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Invite from {channel.orgId}</Text>
            <AdaptiveTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search org members…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
            />
            {invitables.length === 0 ? (
              <Text style={styles.empty}>
                {orgMembersQuery.isLoading
                  ? "Loading…"
                  : "No other members to invite."}
              </Text>
            ) : (
              invitables.slice(0, 20).map((m) => {
                if (!m.user) return null;
                return (
                  <Pressable
                    key={m.userId}
                    onPress={() =>
                      addMutation.mutate({ channelId: channel.id, userId: m.userId })
                    }
                    style={styles.row}
                    accessibilityRole="button"
                  >
                    <Avatar name={m.user.name} imageUrl={m.user.image} size={32} />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName}>{m.user.name}</Text>
                      <Text style={styles.rowMeta}>{m.user.email}</Text>
                    </View>
                    <View style={styles.rowAction}>
                      <UserPlus size={16} color={theme.colors.primary} />
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  section: { gap: theme.spacing[1] },
  sectionLabel: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    fontWeight: "600",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  input: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: 14,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    marginBottom: theme.spacing[1],
  },
  empty: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 8,
  },
  rowBody: { flex: 1 },
  rowName: {
    fontSize: 14,
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  rowYou: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontWeight: "400",
  },
  rowMeta: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  rowAction: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 8,
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.colors.surface2,
  },
  radioActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  prefTextWrap: { flex: 1, gap: 2 },
  prefTitle: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  prefHint: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  muteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    marginTop: 4,
  },
}));

function prefLabel(pref: "all" | "mentions" | "nothing"): string {
  if (pref === "all") return "Every new message";
  if (pref === "mentions") return "Only mentions";
  return "Nothing";
}

function prefDescription(pref: "all" | "mentions" | "nothing"): string {
  if (pref === "all") return "Increment the unread count for every message.";
  if (pref === "mentions") return "Only highlight when someone tags you.";
  return "Don't track this channel at all.";
}
