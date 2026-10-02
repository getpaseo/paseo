import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { getIsElectron } from "@/constants/platform";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { BrowserStartPageSection } from "@/desktop/browser/settings/browser-start-page-section";
import { BrowserStreamingSection } from "@/desktop/browser/settings/browser-streaming-section";
import { SavedPasswordsSection } from "@/desktop/browser/settings/saved-passwords-section";
import { BrowserBackupSection } from "@/desktop/browser/settings/browser-backup-section";
import { useHostFeature } from "@/runtime/host-features";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { BrowserImportSection } from "./browser-import-section";
import { BrowserToolsOptInCard } from "./browser-tools-card";

export function HostBrowserPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const hostBrowser = useHostFeature(serverId, "browserScreencast");
  const isLocalDaemon = useIsLocalDaemon(serverId);

  return (
    <View>
      <SettingsSection title={t("settings.browser.title")} info={t("settings.browser.info")}>
        <BrowserToolsOptInCard serverId={serverId} />
        <BrowserStartPageSection />
        <BrowserStreamingSection />
        <SettingsCard>
          <SettingsRow
            label={t("settings.browser.howItWorks.label")}
            hint={t("settings.browser.howItWorks.hint")}
          />
          <SettingsRow
            label={t("settings.browser.jev.label")}
            hint={t("settings.browser.jev.hint")}
          />
          <SettingsRow
            label={t("settings.browser.safety.label")}
            hint={t("settings.browser.safety.hint")}
          />
        </SettingsCard>
      </SettingsSection>
      <BrowserImportSection serverId={serverId} isLocalDaemon={isLocalDaemon} />
      {hostBrowser || getIsElectron() ? <SavedPasswordsSection serverId={serverId} /> : null}
      {getIsElectron() ? <BrowserBackupSection serverId={serverId} /> : null}
      {getIsElectron() && isLocalDaemon && !hostBrowser ? <BrowserDataSection /> : null}
    </View>
  );
}
