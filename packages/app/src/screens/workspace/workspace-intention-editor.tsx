import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";

export function WorkspaceIntentionEditor({
  serverId,
  workspaceId,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const client = useHostRuntimeClient(serverId);
  const workspace = useWorkspace(serverId, workspaceId);
  const [initialValue] = useState(() => workspace?.intent ?? "");
  const [text, setText] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo(() => ({ title: t("newWorkspace.intention.edit") }), [t]);
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  const save = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setWorkspaceIntent(workspaceId, text.trim() ? text : null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common.errors.unableToSave"));
      setPending(false);
    }
  }, [client, onClose, pending, t, text, workspaceId]);
  return (
    <AdaptiveModalSheet visible onClose={close} header={header} testID="workspace-intention-editor">
      <View style={styles.body}>
        <FormTextInput
          size={size}
          initialValue={initialValue}
          onChangeText={setText}
          multiline
          numberOfLines={4}
          autoFocus
          editable={!pending}
          accessibilityLabel={t("newWorkspace.intention.label")}
          testID="workspace-intention-input"
        />
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button size={size} onPress={close} disabled={pending}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            size={size}
            variant="default"
            onPress={save}
            disabled={pending || text === initialValue}
            testID="workspace-intention-save"
          >
            {t("newWorkspace.intention.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[4] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive },
}));
