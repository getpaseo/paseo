import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSwitch } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";

interface SystemOneSwitchesProps {
  browserGoals: boolean;
  shadow: boolean;
  disabled: boolean;
  onChange: (patch: { browserGoals?: boolean; shadow?: boolean }) => void;
}

/** Where Jev spends tokens on its own; the counts live on the Usage page. */
export function SystemOneSwitches({
  browserGoals,
  shadow,
  disabled,
  onChange,
}: SystemOneSwitchesProps) {
  const { t } = useTranslation();
  const setBrowserGoals = useCallback(
    (value: boolean) => onChange({ browserGoals: value }),
    [onChange],
  );
  const setShadow = useCallback((value: boolean) => onChange({ shadow: value }), [onChange]);
  return (
    <SettingsSection
      title={t("settings.systemOne.usage.title")}
      info={t("settings.systemOne.usage.info")}
    >
      <SettingsCard testID="host-system-one-usage">
        <SettingsSwitch
          label={t("settings.systemOne.usage.browserGoals.label")}
          hint={t("settings.systemOne.usage.browserGoals.hint")}
          value={browserGoals}
          disabled={disabled}
          onValueChange={setBrowserGoals}
        />
        <SettingsSwitch
          label={t("settings.systemOne.usage.shadow.label")}
          hint={t("settings.systemOne.usage.shadow.hint")}
          value={shadow}
          disabled={disabled}
          onValueChange={setShadow}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
