import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { customThemeSchema, type CustomThemePreset } from "@/styles/custom-theme";
import { settingsStyles } from "@/styles/settings";
import { pickCustomThemeJson } from "./pick-custom-theme-file";

type ImportState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

interface CustomThemeImportRowProps {
  customThemeName: string | null;
  onImport: (preset: CustomThemePreset) => Promise<void>;
}

export function CustomThemeImportRow({ customThemeName, onImport }: CustomThemeImportRowProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ImportState>({ status: "idle" });

  const importTheme = useCallback(async () => {
    setState({ status: "pending" });
    try {
      const json = await pickCustomThemeJson();
      if (json === null) {
        setState({ status: "idle" });
        return;
      }
      const preset = customThemeSchema.parse(JSON.parse(json));
      await onImport(preset);
      setState({ status: "idle" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onImport]);

  const description = customThemeName ?? t("settings.appearance.theme.custom.none");

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.theme.custom.title")}</Text>
        <Text style={settingsStyles.rowHint}>{description}</Text>
        {state.status === "error" ? (
          <Text style={settingsStyles.rowError}>{state.message}</Text>
        ) : null}
      </View>
      <Button
        variant="outline"
        size="sm"
        loading={state.status === "pending"}
        onPress={importTheme}
      >
        {state.status === "pending"
          ? t("settings.appearance.theme.custom.importing")
          : t("settings.appearance.theme.custom.import")}
      </Button>
    </View>
  );
}
