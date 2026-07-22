import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isElectronRuntimeMac } from "@/desktop/host";
import { settingsStyles } from "@/styles/settings";
import { ImportSheet, type ImportSourceDescriptor, useImportAvailability } from "./import-sheet";

export function ExternalImport({ source }: { source: ImportSourceDescriptor }) {
  const { t } = useTranslation();
  const importFlow = useImportAvailability(source.id);
  if (!isElectronRuntimeMac()) return null;

  return (
    <>
      <View
        style={[settingsStyles.row, settingsStyles.rowBorder]}
        testID={`${source.id}-import-row`}
      >
        <View style={settingsStyles.rowContent}>
          <View style={styles.titleRow}>
            <Image source={source.icon} style={styles.icon} />
            <Text style={settingsStyles.rowTitle}>{source.title}</Text>
          </View>
          <Text style={settingsStyles.rowHint}>
            {importFlow.reason ?? t("desktop.integrations.import.description")}
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          onPress={importFlow.open}
          disabled={!importFlow.available}
          testID={`${source.id}-import-open`}
        >
          {t("desktop.integrations.import.actions.import")}
        </Button>
      </View>
      <ImportSheet source={source} visible={importFlow.visible} onClose={importFlow.close} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  icon: { width: theme.iconSize.md, height: theme.iconSize.md },
}));
