import { FileText } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { isWeb } from "@/constants/platform";
import { buildScratchFileStorageKey, useScratchFileStore } from "@/stores/scratch-file-store";

function useScratchFilePanelDescriptor(
  _target: { kind: "scratch_file"; fileId: string },
  context: { title?: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const label = context.title?.trim() || t("workspace.tabs.fallback.file");
  return {
    label,
    subtitle: t("workspace.tabs.fallback.file"),
    tooltip: label,
    titleState: "ready",
    icon: FileText,
    statusBucket: null,
  };
}

function ScratchFilePanel() {
  const { serverId, workspaceId, tabId, target } = usePaneContext();
  invariant(target.kind === "scratch_file", "ScratchFilePanel requires scratch file target");
  const storageKey = useMemo(
    () => buildScratchFileStorageKey({ serverId, workspaceId, tabId }),
    [serverId, tabId, workspaceId],
  );
  const content = useScratchFileStore((state) => state.contentsByKey[storageKey] ?? "");
  const setContent = useScratchFileStore((state) => state.setContent);
  const handleChangeText = useCallback(
    (value: string) => setContent(storageKey, value),
    [setContent, storageKey],
  );
  usePublishPanelInstanceAttributes({ modified: content.length > 0 });

  return (
    <View style={styles.container} testID="workspace-scratch-file-pane">
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={isWeb}
        multiline
        onChangeText={handleChangeText}
        scrollEnabled
        spellCheck={false}
        style={styles.editor}
        testID="workspace-scratch-file-editor"
        textAlignVertical="top"
        value={content}
      />
    </View>
  );
}

export const scratchFilePanelRegistration: PanelRegistration<"scratch_file"> = {
  kind: "scratch_file",
  component: ScratchFilePanel,
  useDescriptor: useScratchFilePanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  editor: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[4],
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.5,
  },
}));
