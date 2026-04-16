import { useState, useCallback, useEffect } from "react";
import { Pressable, Text, TextInput, View, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, Copy, Link2, X } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useShareSession, type ShareInfo } from "@/hooks/sharing";
import type { DesktopOrgMember } from "@/desktop/auth/desktop-auth";
import { getDesktopDaemonPairing } from "@/desktop/daemon/desktop-daemon";
import { getIsElectron } from "@/constants/platform";

interface ShareSessionModalProps {
  visible: boolean;
  onClose: () => void;
  daemonSessionId: string;
  serverId: string;
  orgId?: string;
  members?: DesktopOrgMember[];
}

export function ShareSessionModal({
  visible,
  onClose,
  daemonSessionId,
  serverId,
  orgId,
  members,
}: ShareSessionModalProps) {
  const { theme } = useUnistyles();
  const { shareInfo, createShare, isCreating, createError } = useShareSession();
  const [accessLevel, setAccessLevel] = useState<"read_only" | "full_access">("read_only");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const toggleUser = useCallback((userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    // Get pairing URL from daemon (for relay connection)
    let pairingUrl: string | undefined;
    if (getIsElectron()) {
      try {
        const pairing = await getDesktopDaemonPairing();
        if (pairing.url) pairingUrl = pairing.url;
      } catch {
        // Non-critical — share works without pairing URL
      }
    }

    await createShare({
      daemonSessionId,
      serverId,
      orgId: orgId ?? "",
      accessLevel,
      pairingUrl,
      allowedUserIds: Array.from(selectedUserIds),
    });
  }, [createShare, daemonSessionId, serverId, orgId, accessLevel, selectedUserIds]);

  const memberList = members ?? [];

  const handleCopy = useCallback(async () => {
    if (!shareInfo?.shareUrl) return;
    await Clipboard.setStringAsync(shareInfo.shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareInfo]);

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title="Share this session">
      <View style={styles.content}>
        {!shareInfo ? (
          <>
            <Text style={styles.label}>Access level</Text>
            <View style={styles.accessRow}>
              <Pressable
                style={[
                  styles.accessOption,
                  accessLevel === "read_only" && styles.accessOptionSelected,
                ]}
                onPress={() => setAccessLevel("read_only")}
              >
                <Text
                  style={[
                    styles.accessOptionText,
                    accessLevel === "read_only" && styles.accessOptionTextSelected,
                  ]}
                >
                  Can view
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.accessOption,
                  accessLevel === "full_access" && styles.accessOptionSelected,
                ]}
                onPress={() => setAccessLevel("full_access")}
              >
                <Text
                  style={[
                    styles.accessOptionText,
                    accessLevel === "full_access" && styles.accessOptionTextSelected,
                  ]}
                >
                  Can interact
                </Text>
              </Pressable>
            </View>

            <Text style={styles.label}>Select members</Text>
            <ScrollView style={styles.memberList}>
              {memberList.map((m) => {
                const selected = selectedUserIds.has(m.userId);
                return (
                  <Pressable
                    key={m.userId}
                    style={styles.memberRow}
                    onPress={() => toggleUser(m.userId)}
                  >
                    <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                      {selected && <Check size={12} color={theme.colors.accentForeground} />}
                    </View>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.user?.name ?? "Unknown"}
                    </Text>
                    <Text style={styles.memberEmail} numberOfLines={1}>
                      {m.user?.email ?? ""}
                    </Text>
                  </Pressable>
                );
              })}
              {memberList.length === 0 && (
                <Text style={styles.emptyHint}>No other members in this organization.</Text>
              )}
            </ScrollView>

            {createError && <Text style={styles.error}>{createError}</Text>}

            <Button
              variant="default"
              size="md"
              leftIcon={<Link2 size={14} color={theme.colors.accentForeground} />}
              onPress={() => void handleCreate()}
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create share link"}
            </Button>
          </>
        ) : (
          <View style={styles.shareResult}>
            <Text style={styles.shareResultTitle}>Share link created</Text>
            <Text style={styles.shareResultHint}>
              {accessLevel === "full_access"
                ? "Members can interact with the agent"
                : "Members can view the agent session"}
            </Text>
            <View style={styles.linkRow}>
              <TextInput
                style={[styles.linkInput, { color: theme.colors.foreground }]}
                value={shareInfo.shareUrl}
                readOnly
                selectTextOnFocus
              />
              <Button
                variant="outline"
                size="sm"
                leftIcon={
                  copied ? (
                    <Check size={14} color={theme.colors.accent} />
                  ) : (
                    <Copy size={14} color={theme.colors.foreground} />
                  )
                }
                onPress={() => void handleCopy()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </View>
            <Button variant="ghost" size="sm" onPress={onClose}>
              Done
            </Button>
          </View>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  accessRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  accessOption: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  accessOptionSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  accessOptionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  accessOptionTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  memberList: {
    maxHeight: 200,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  memberName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  memberEmail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  shareResult: {
    alignItems: "center",
    gap: theme.spacing[3],
  },
  shareResultTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  shareResultHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    width: "100%",
  },
  linkInput: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    outlineStyle: "none",
  } as any,
}));
