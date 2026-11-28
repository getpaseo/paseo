import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isNative } from "@/constants/platform";
import { useAppSettings, type ChatDisplay, type ItemTimesPreferences } from "@/hooks/use-settings";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];
const ITEM_TIME_KINDS = ["assistant", "toolCalls", "thinking", "user"] as const;

export function ChatSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void updateSettings({ chatDisplay }),
    [updateSettings],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void updateSettings({ autoExpandReasoning }),
    [updateSettings],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void updateSettings({ chatOutlineEnabled }),
    [updateSettings],
  );
  const changeItemTimes = useCallback(
    (patch: Partial<ItemTimesPreferences>) =>
      void updateSettings((current) => ({ itemTimes: { ...current.itemTimes, ...patch } })),
    [updateSettings],
  );
  const changeItemTimesEnabled = useCallback(
    (enabled: boolean) => changeItemTimes({ enabled }),
    [changeItemTimes],
  );
  const changeItemTimeKinds = useMemo(
    () => ({
      assistant: (value: boolean) => changeItemTimes({ assistant: value }),
      toolCalls: (value: boolean) => changeItemTimes({ toolCalls: value }),
      thinking: (value: boolean) => changeItemTimes({ thinking: value }),
      user: (value: boolean) => changeItemTimes({ user: value }),
    }),
    [changeItemTimes],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSelect
            label={t("settings.general.chatDisplay.label")}
            hint={t("settings.general.chatDisplay.description")}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          {isNative ? null : (
            <SettingsSwitch
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.general.itemTimes.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.itemTimes.enabled.label")}
            hint={t("settings.general.itemTimes.enabled.description")}
            value={settings.itemTimes.enabled}
            onValueChange={changeItemTimesEnabled}
          />
          {ITEM_TIME_KINDS.map((kind) => (
            <SettingsSwitch
              key={kind}
              label={t(`settings.general.itemTimes.${kind}`)}
              value={settings.itemTimes[kind]}
              disabled={!settings.itemTimes.enabled}
              onValueChange={changeItemTimeKinds[kind]}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
