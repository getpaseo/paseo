import { UnistylesRuntime } from "react-native-unistyles";
import { i18n } from "@/i18n/i18next";
export function pdfViewInput(uri: string) {
  const theme = UnistylesRuntime.getTheme();
  return {
    uri,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    border: theme.colors.border,
    search: i18n.t("fileAccess.pdfSearch"),
    password: i18n.t("fileAccess.pdfPassword"),
    loading: i18n.t("fileAccess.preparing"),
  };
}
