import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { useAppSettings, type SendBehavior } from "@/hooks/use-settings";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getShortcutOs } from "@/utils/shortcut-platform";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const options = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (sendBehavior: SendBehavior) => void updateSettings({ sendBehavior }),
    [updateSettings],
  );
  const changeCommandEnterToSend = useCallback(
    (commandEnterToSend: boolean) => void updateSettings({ commandEnterToSend }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(
            settings.commandEnterToSend
              ? `settings.general.defaultSend.commandEnterDescriptions.${settings.sendBehavior}`
              : `settings.general.defaultSend.descriptions.${settings.sendBehavior}`,
            { modifier },
          )}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
        {shortcutsAvailable ? (
          <SettingsSwitch
            label={t("settings.general.commandEnterToSend.label", { modifier })}
            hint={t("settings.general.commandEnterToSend.description", { modifier })}
            value={settings.commandEnterToSend}
            onValueChange={changeCommandEnterToSend}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
