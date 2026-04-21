import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FolderOpen, Terminal, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { LibraryEntry } from "@/api/library";
import { getDesktopHost } from "@/desktop/host";

export interface SkillDetailModalProps {
  visible: boolean;
  onClose: () => void;
  entry: LibraryEntry | null;
  /** Called after the user confirms uninstall — caller wires the mutation. */
  onUninstall: (entry: LibraryEntry) => Promise<void> | void;
  uninstallPending?: boolean;
}

/**
 * Detail/manage modal for an installed skill. We compute the on-disk folder
 * as `~/.agentskills/<entry.name>/` to mirror what `syncLibraryToTargets`
 * writes; the desktop wrapper expands the `~` when invoking the OS opener.
 *
 * The Open-in-Terminal / Reveal-in-Finder buttons only render in Electron —
 * web/mobile builds don't have a filesystem to point at.
 */
export function SkillDetailModal({
  visible,
  onClose,
  entry,
  onUninstall,
  uninstallPending,
}: SkillDetailModalProps) {
  const host = getDesktopHost();
  const isDesktop = !!host?.invoke;

  const folderPath = useMemo(() => {
    if (!entry) return null;
    return `~/.agentskills/${entry.name}`;
  }, [entry]);

  if (!entry) return null;

  const openInTerminal = () => {
    if (!folderPath) return;
    void host?.invoke?.("open_in_terminal", { directory: folderPath });
  };
  const revealInFinder = () => {
    if (!folderPath) return;
    void host?.invoke?.("reveal_in_finder", { absolutePath: `${folderPath}/SKILL.md` });
  };
  const handleUninstall = async () => {
    if (uninstallPending) return;
    await onUninstall(entry);
  };

  const previewBody = entry.payload && "instructionsInline" in entry.payload
    ? entry.payload.instructionsInline ?? ""
    : "";

  return (
    <AdaptiveModalSheet title={entry.displayName || entry.name} visible={visible} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {entry.description ? (
          <Text style={styles.description}>{entry.description}</Text>
        ) : null}

        {folderPath ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Local folder</Text>
            <Text style={styles.path} selectable>
              {folderPath}/SKILL.md
            </Text>
          </View>
        ) : null}

        {previewBody ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Instructions preview</Text>
            <Text style={styles.preview} numberOfLines={12}>
              {previewBody.trim()}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          {isDesktop ? (
            <>
              <Pressable
                onPress={openInTerminal}
                style={({ hovered }) => [styles.btn, hovered && styles.btnHovered]}
                accessibilityRole="button"
              >
                <Terminal size={14} color="currentColor" />
                <Text style={styles.btnLabel}>Open in Terminal</Text>
              </Pressable>
              <Pressable
                onPress={revealInFinder}
                style={({ hovered }) => [styles.btn, hovered && styles.btnHovered]}
                accessibilityRole="button"
              >
                <FolderOpen size={14} color="currentColor" />
                <Text style={styles.btnLabel}>Reveal in Finder</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable
            onPress={handleUninstall}
            disabled={uninstallPending}
            style={({ hovered }) => [
              styles.btn,
              styles.btnDanger,
              hovered && !uninstallPending && styles.btnDangerHovered,
              uninstallPending && { opacity: 0.6 },
            ]}
            accessibilityRole="button"
          >
            <Trash2 size={14} color="currentColor" />
            <Text style={[styles.btnLabel, styles.btnLabelDanger]}>
              {uninstallPending ? "Uninstalling…" : "Uninstall"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  path: {
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  preview: {
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
  },
  btnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  btnLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  btnDanger: {
    borderColor: theme.colors.destructive,
    backgroundColor: "transparent",
  },
  btnDangerHovered: {
    backgroundColor: theme.colors.destructive,
  },
  btnLabelDanger: {
    color: theme.colors.destructive,
  },
}));
