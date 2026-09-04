import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { getIsElectron } from "@/constants/platform";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { RemoteDestination } from "@/workspace/desktop-open-targets";
import {
  sshDestination,
  suggestSshHost,
  useEditorRemoteDestination,
} from "@/workspace/open-in-editor/remote-destination";

const ThemedPencil = withUnistyles(Pencil);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SshHostModalProps {
  initialValue: string;
  onClose: () => void;
  onSubmit: (destination: RemoteDestination | null) => Promise<void>;
}

/**
 * Asks for a plain SSH host. No `ssh-remote+` decoration: that is a VS Code dialect, and the
 * same value also builds Zed's `ssh://` URL. Unlike the rename modal this accepts the value
 * it was prefilled with — the suggestion from the host name is usually the answer — and
 * treats an empty field as "not configured", which is how the setting is turned off.
 */
function SshHostModal({ initialValue, onClose, onSubmit }: SshHostModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.openInEditor.sshHost.modalTitle") }),
    [t],
  );

  const handleChange = useCallback((value: string) => {
    setDraft(value);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (isPending) return;
    const destination = sshDestination(draft);
    if (!destination && draft.trim().length > 0) {
      setError(t("settings.host.openInEditor.sshHost.invalid"));
      return;
    }
    setIsPending(true);
    try {
      await onSubmit(destination);
      onClose();
    } catch (cause) {
      setIsPending(false);
      setError(cause instanceof Error ? cause.message : t("common.errors.unableToSave"));
    }
  }, [draft, isPending, onClose, onSubmit, t]);

  const handleSubmit = useCallback(() => void submit(), [submit]);
  const handleCancel = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);

  return (
    <AdaptiveModalSheet
      visible
      onClose={handleCancel}
      header={header}
      testID="host-open-in-editor-modal"
    >
      <View style={styles.modalBody}>
        <AdaptiveTextInput
          initialValue={initialValue}
          onChangeText={handleChange}
          placeholder={t("settings.host.openInEditor.sshHost.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          onSubmitEditing={handleSubmit}
          style={styles.modalInput}
          testID="host-open-in-editor-modal-input"
        />
        <Text style={styles.modalHint}>{t("settings.host.openInEditor.sshHost.modalHint")}</Text>
        {error ? (
          <Text style={styles.modalError} testID="host-open-in-editor-modal-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.modalActions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.modalAction}
            onPress={handleCancel}
            disabled={isPending}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.modalAction}
            onPress={handleSubmit}
            disabled={isPending}
            testID="host-open-in-editor-modal-submit"
          >
            {t("settings.host.openInEditor.sshHost.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

interface HostOpenInEditorSectionProps {
  serverId: string;
  isLocalDaemon: boolean;
}

/**
 * Only the desktop app can launch an editor, and a daemon on this machine needs no
 * destination — everywhere else the setting would be dead weight, so it is not rendered.
 */
export function HostOpenInEditorSection({ serverId, isLocalDaemon }: HostOpenInEditorSectionProps) {
  const { t } = useTranslation();
  const { remoteDestination, updateRemoteDestination } = useEditorRemoteDestination(serverId);
  const hostname = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.hostname ?? null,
  );
  const [isEditing, setIsEditing] = useState(false);

  const openEditor = useCallback(() => setIsEditing(true), []);
  const closeEditor = useCallback(() => setIsEditing(false), []);

  if (!getIsElectron() || isLocalDaemon || remoteDestination === undefined) {
    return null;
  }

  const draft = remoteDestination?.host ?? suggestSshHost(hostname);

  return (
    <SettingsSection
      title={t("settings.host.openInEditor.title")}
      info={t("settings.host.openInEditor.info")}
      testID="host-open-in-editor"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.openInEditor.sshHost.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.openInEditor.sshHost.hint")}
            </Text>
          </View>
          <View style={styles.value}>
            <Text style={styles.valueText} numberOfLines={1}>
              {remoteDestination?.host ?? t("settings.host.openInEditor.sshHost.notSet")}
            </Text>
            <Pressable
              onPress={openEditor}
              hitSlop={8}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={t("settings.host.openInEditor.sshHost.editLabel")}
              testID="host-open-in-editor-edit"
            >
              <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            </Pressable>
          </View>
        </View>
      </View>

      {isEditing ? (
        <SshHostModal
          initialValue={draft}
          onClose={closeEditor}
          onSubmit={updateRemoteDestination}
        />
      ) : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  valueText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  modalBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  modalInput: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  modalHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  modalError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  modalActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modalAction: {
    flex: 1,
  },
}));
