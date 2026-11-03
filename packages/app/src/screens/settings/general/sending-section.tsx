import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useAppSettings, type SendShortcut, type SendBehavior } from "@/hooks/use-settings";
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
  const shortcutOptions = useMemo(
    () =>
      (["enter", "mod-enter"] as const).map((value) => ({
        value,
        label: t(`settings.general.sendShortcut.options.${value}`, { modifier }),
      })),
    [t, modifier],
  );
  const changeSendShortcut = useCallback(
    (sendShortcut: SendShortcut) => void updateSettings({ sendShortcut }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        {shortcutsAvailable ? (
          <SettingsSelect
            label={t("settings.general.sendShortcut.label")}
            value={settings.sendShortcut}
            options={shortcutOptions}
            onValueChange={changeSendShortcut}
          />
        ) : null}
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(
            shortcutsAvailable && settings.sendShortcut === "mod-enter"
              ? `settings.general.defaultSend.commandEnterDescriptions.${settings.sendBehavior}`
              : `settings.general.defaultSend.descriptions.${settings.sendBehavior}`,
            { modifier },
          )}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
