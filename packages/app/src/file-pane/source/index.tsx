import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { FileSourceView } from "./view";

/** Read-only source preview. The source module owns platform rendering and its theme. */
export function WorkspaceFileSource(props: {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
}) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [theme],
  );
  return (
    <FileSourceView
      {...props}
      theme={visualTheme}
      tooLargeMessage={t("panels.file.tooLargeToDisplay")}
    />
  );
}
