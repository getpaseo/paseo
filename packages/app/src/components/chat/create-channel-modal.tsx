import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import {
  useAddChannelMemberMutation,
  useCreateChannelMutation,
} from "@/hooks/chat/use-chat-queries";
import { useOrgMembersQuery } from "@/hooks/chat/use-org-members";
import { Avatar } from "./avatar";

interface CreateChannelModalProps {
  visible: boolean;
  orgId: string;
  sessionToken: string | null;
  currentUserId: string | null;
  onClose: () => void;
  onCreated?: (channelId: string) => void;
}

export function CreateChannelModal({
  visible,
  orgId,
  sessionToken,
  currentUserId,
  onClose,
  onCreated,
}: CreateChannelModalProps) {
  const { theme } = useUnistyles();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const [memberQuery, setMemberQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateChannelMutation(sessionToken);
  const addMemberMutation = useAddChannelMemberMutation(sessionToken);
  const orgMembersQuery = useOrgMembersQuery(orgId, sessionToken);

  const invitables = useMemo(() => {
    const list = (orgMembersQuery.data ?? []).filter((m) => m.user && m.userId !== currentUserId);
    if (!memberQuery.trim()) return list;
    const q = memberQuery.trim().toLowerCase();
    return list.filter((m) => {
      const n = m.user?.name.toLowerCase() ?? "";
      const e = m.user?.email.toLowerCase() ?? "";
      return n.includes(q) || e.includes(q);
    });
  }, [orgMembersQuery.data, memberQuery, currentUserId]);

  const reset = () => {
    setName("");
    setTopic("");
    setKind("public");
    setMemberQuery("");
    setSelected(new Set());
    setError(null);
    setSubmitting(false);
  };

  const toggleMember = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const chan = await createMutation.mutateAsync({
        orgId,
        name: name.trim(),
        kind,
        topic,
      });
      // Best-effort invite: failures on a single invite don't roll back the
      // channel — surface them collectively so the user knows.
      const failures: string[] = [];
      // Public channels: every org member is an implicit member, so we skip
      // the explicit invite step entirely.
      const inviteIds = kind === "public" ? [] : Array.from(selected);
      for (const userId of inviteIds) {
        try {
          await addMemberMutation.mutateAsync({
            channelId: chan.id,
            userId,
          });
        } catch (err) {
          const m = orgMembersQuery.data?.find((x) => x.userId === userId);
          failures.push(m?.user?.name ?? userId);
        }
      }
      if (failures.length > 0) {
        setError(`Channel created, but couldn't invite: ${failures.join(", ")}`);
        setSubmitting(false);
        return;
      }
      onCreated?.(chan.id);
      reset();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create channel";
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <AdaptiveModalSheet
      title="Create channel"
      visible={visible}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <View style={styles.body}>
        <Field label="Name">
          <AdaptiveTextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. project-alpha"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            focusBorderColor={theme.colors.brandMagenta}
          />
          <Text style={styles.hint}>Letters, numbers and hyphens only. Spaces become hyphens.</Text>
        </Field>

        <Field label="Topic">
          <AdaptiveTextInput
            value={topic}
            onChangeText={setTopic}
            placeholder="What's this channel about?"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            focusBorderColor={theme.colors.brandMagenta}
          />
        </Field>

        <Field label="Visibility">
          <View style={styles.segment}>
            <Pressable
              onPress={() => setKind("public")}
              style={[styles.segmentBtn, kind === "public" && styles.segmentBtnActive]}
            >
              <Text style={[styles.segmentText, kind === "public" && styles.segmentTextActive]}>
                Public — everyone in the org
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setKind("private")}
              style={[styles.segmentBtn, kind === "private" && styles.segmentBtnActive]}
            >
              <Text style={[styles.segmentText, kind === "private" && styles.segmentTextActive]}>
                Private — invite only
              </Text>
            </Pressable>
          </View>
        </Field>

        {kind === "private" ? (
          <Field label={`Invite members${selected.size > 0 ? ` (${selected.size})` : ""}`}>
            <AdaptiveTextInput
              value={memberQuery}
              onChangeText={setMemberQuery}
              placeholder="Search org members…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              focusBorderColor={theme.colors.brandMagenta}
            />
            <ScrollView
              style={styles.membersList}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {orgMembersQuery.isLoading ? (
                <Text style={styles.hint}>Loading org members…</Text>
              ) : invitables.length === 0 ? (
                <Text style={styles.hint}>
                  {memberQuery ? "No matches." : "No other members in this org yet."}
                </Text>
              ) : (
                invitables.slice(0, 50).map((m) => {
                  if (!m.user) return null;
                  const picked = selected.has(m.userId);
                  return (
                    <Pressable
                      key={m.userId}
                      onPress={() => toggleMember(m.userId)}
                      style={styles.memberRow}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: picked }}
                    >
                      <Avatar name={m.user.name} imageUrl={m.user.image} size={28} />
                      <View style={styles.memberBody}>
                        <Text style={styles.memberName}>{m.user.name}</Text>
                        <Text style={styles.memberEmail}>{m.user.email}</Text>
                      </View>
                      <View style={[styles.checkbox, picked && styles.checkboxChecked]}>
                        {picked ? <Check size={14} color="#ffffff" /> : null}
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Field>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.footer}>
          <Pressable
            onPress={() => {
              reset();
              onClose();
            }}
            style={styles.cancelBtn}
            accessibilityRole="button"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={!name.trim() || submitting}
            style={[styles.submitBtn, (!name.trim() || submitting) && styles.submitBtnDisabled]}
            accessibilityRole="button"
          >
            <Text style={styles.submitText}>{submitting ? "Creating…" : "Create"}</Text>
          </Pressable>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  field: { gap: 6 },
  label: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    fontWeight: "600",
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
  },
  hint: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  segment: {
    flexDirection: "column",
    gap: 6,
  },
  segmentBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  segmentBtnActive: {
    borderColor: theme.colors.brandMagenta,
    backgroundColor: theme.colors.surface1,
  },
  segmentText: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
  segmentTextActive: {
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  membersList: {
    maxHeight: 220,
    marginTop: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  memberBody: { flex: 1 },
  memberName: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  memberEmail: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginTop: 1,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.brandMagenta,
    borderColor: theme.colors.brandMagenta,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  cancelBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: 6,
  },
  cancelText: {
    color: theme.colors.foregroundMuted,
    fontSize: 14,
    fontWeight: "500",
  },
  submitBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: theme.colors.brandMagenta,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  error: {
    color: "#e57373",
    fontSize: 13,
    backgroundColor: "rgba(229,115,115,0.1)",
    borderRadius: 6,
    padding: theme.spacing[2],
  },
}));
