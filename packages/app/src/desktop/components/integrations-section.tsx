import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFocusEffect } from "expo-router/react-navigation";
import { Switch } from "@/components/ui/switch";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";

export function IntegrationsSection() {
  const { t } = useTranslation();
  const cli = useCliInstall();
  const { available, refresh, setInstalled } = cli;
  useFocusEffect(
    useCallback(() => {
      if (available) refresh();
      return undefined;
    }, [refresh, available]),
  );
  const handleValueChange = useCallback(
    (next: boolean) => {
      void setInstalled(next);
    },
    [setInstalled],
  );
  const docsLink = useMemo(
    () => ({
      href: CLI_DOCS_URL,
      label: t("settings.integrations.docs.cli"),
      accessibilityLabel: t("settings.integrations.docs.openCli"),
    }),
    [t],
  );
  if (!available) return null;
  return (
    <SettingsSection title={t("settings.integrations.title")} link={docsLink}>
      <SettingsCard>
        <CommandLineRow
          value={cli.status?.installed ?? false}
          onValueChange={handleValueChange}
          disabled={cli.status === null || cli.isWorking}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** The `paseo` CLI row: on means installed on this computer. */
export function CommandLineRow({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("settings.integrations.commandLine.title")}
      hint={t("settings.integrations.commandLine.description")}
    >
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={t("settings.integrations.commandLine.accessibilityLabel")}
      />
    </SettingsRow>
  );
}
