import { useCallback, useMemo } from "react";
import { Paperclip } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { TerminalKeyBarIconAction } from "@/components/terminal-copy-paste-actions";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import { toErrorMessage } from "@/utils/error-messages";
import type { SelectedFile } from "@/attachments/selected-file";
import type { TerminalInputSink } from "@/terminal/input-sink";

const ThemedPaperclip = withUnistyles(Paperclip);
const toolbarIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const keyBarIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TerminalUploadButtonProps {
  sink: TerminalInputSink;
  placement: "toolbar" | "keybar";
}

/**
 * Picks files and hands them to the terminal's sink. The sink is the one this
 * button rendered with when pressed, so files picked for a terminal reach it even
 * if the pane switched to another terminal while the picker was open.
 */
export function TerminalUploadButton({ sink, placement }: TerminalUploadButtonProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { pickFiles } = useFilePicker();
  const label = t("workspace.terminal.actions.uploadFile");

  const handlePress = useCallback(async () => {
    let files: SelectedFile[] | null;
    try {
      files = await pickFiles();
    } catch (error) {
      toast.error(t("workspace.terminal.pasteFileFailed", { reason: toErrorMessage(error) }));
      return;
    }
    if (files && files.length > 0) {
      sink.deliverFiles(files);
    } else {
      sink.focus();
    }
  }, [pickFiles, sink, t, toast]);
  const keyBarIcon = useMemo(
    () => <ThemedPaperclip size={16} uniProps={keyBarIconColorMapping} />,
    [],
  );

  if (placement === "toolbar") {
    return (
      <ToolbarButton label={label} testID="terminal-toolbar-upload" onPress={handlePress}>
        <ThemedPaperclip size={14} uniProps={toolbarIconColorMapping} />
      </ToolbarButton>
    );
  }

  return (
    <TerminalKeyBarIconAction
      accessibilityLabel={label}
      testID="terminal-upload"
      icon={keyBarIcon}
      onPress={handlePress}
    />
  );
}
