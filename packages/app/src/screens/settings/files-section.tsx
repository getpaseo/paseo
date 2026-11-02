import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import {
  filePanelIcon,
  filePanelOptionLabel,
  filePanelSelectorLabel,
  useFilePanelSettings,
  type FilePanel,
  type FilePanelSettingsRow,
} from "@/file-panels";
import { PluginIconView } from "@/plugins/icons";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const MENU_ICON_SIZE = 16;

const ThemedPanelIcon = withUnistyles(PluginIconView);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Which panel opens each file type, for the types more than one panel claims. */
export function FilesSection() {
  const { t } = useTranslation();
  const { rows, choose, askAgain } = useFilePanelSettings();
  return (
    <SettingsSection title={t("settings.files.title")} testID="file-panel-settings">
      {rows.length === 0 ? (
        <View style={settingsStyles.card} testID="file-panel-settings-empty">
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{t("settings.files.empty")}</Text>
          </View>
        </View>
      ) : (
        <SettingsCard testID="file-panel-settings-card">
          {rows.map((row) => (
            <FilePanelSettingsRowView
              key={row.selectorKey}
              row={row}
              onChoose={choose}
              onAskAgain={askAgain}
            />
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}

function FilePanelSettingsRowView({
  row,
  onChoose,
  onAskAgain,
}: {
  row: FilePanelSettingsRow<FilePanel>;
  onChoose(selectorKey: string, panelId: string): void;
  onAskAgain(selectorKey: string): void;
}) {
  const { t } = useTranslation();
  const { selectorKey, associatedPanelId } = row;
  const label = filePanelSelectorLabel(selectorKey);
  const value = associatedValueLabel(t, row);
  const choose = useCallback(
    (panelId: string) => onChoose(selectorKey, panelId),
    [onChoose, selectorKey],
  );
  const askAgain = useCallback(() => onAskAgain(selectorKey), [onAskAgain, selectorKey]);
  return (
    <SettingsRow label={label} testID={`file-panel-settings-row-${selectorKey}`}>
      <View style={styles.controls}>
        <DropdownMenu>
          <DropdownTrigger
            disabled={row.candidates.length === 0}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${value}`}
          >
            {value}
          </DropdownTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            minWidth={260}
            maxWidth={360}
            testID="file-panel-settings-menu"
          >
            {row.candidates.map((panel) => (
              <FilePanelOption
                key={panel.id}
                panel={panel}
                selected={panel.id === associatedPanelId}
                onSelect={choose}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          onPress={askAgain}
          disabled={associatedPanelId === null}
          accessibilityLabel={t("settings.files.askAgainFor", { label })}
        >
          {t("settings.files.askAgain")}
        </Button>
      </View>
    </SettingsRow>
  );
}

/** What the dropdown shows: the remembered panel, or that Paseo asks on every open. */
function associatedValueLabel(t: TFunction, row: FilePanelSettingsRow<FilePanel>): string {
  if (row.associatedPanelId === null) return t("settings.files.askEveryTime");
  const panel = row.candidates.find((candidate) => candidate.id === row.associatedPanelId);
  return panel ? filePanelOptionLabel(t, panel) : t("settings.files.unavailable");
}

function FilePanelOption({
  panel,
  selected,
  onSelect,
}: {
  panel: FilePanel;
  selected: boolean;
  onSelect(panelId: string): void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => onSelect(panel.id), [onSelect, panel.id]);
  const leading = useMemo(
    () => (
      <ThemedPanelIcon
        icon={filePanelIcon(panel)}
        size={MENU_ICON_SIZE}
        uniProps={mutedIconMapping}
      />
    ),
    [panel],
  );
  return (
    <DropdownMenuItem selected={selected} leading={leading} onSelect={select}>
      {filePanelOptionLabel(t, panel)}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
