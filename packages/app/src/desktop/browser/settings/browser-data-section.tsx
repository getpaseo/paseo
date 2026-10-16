import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsSelect } from "@/components/settings";
import { getIsElectron } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useBrowserStore } from "@/desktop/browser/store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

export function BrowserDataSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const clearInFlightRef = useRef(false);
  const [isClearing, setIsClearing] = useState(false);

  const handleClear = useCallback(async () => {
    if (clearInFlightRef.current) {
      return;
    }

    clearInFlightRef.current = true;
    setIsClearing(true);
    try {
      const confirmed = await confirmDialog({
        title: t("settings.general.browserData.confirmTitle"),
        message: t("settings.general.browserData.confirmMessage"),
        confirmLabel: t("settings.general.browserData.clear"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const clearProfile = getDesktopHost()?.browser?.clearProfile;
      if (!clearProfile) {
        throw new Error("Electron browser profile bridge is unavailable");
      }

      await clearProfile(Object.keys(useBrowserStore.getState().browsersById));
      toast.show(t("settings.general.browserData.success"), { variant: "success" });
    } catch {
      toast.error(t("settings.general.browserData.error"));
    } finally {
      clearInFlightRef.current = false;
      setIsClearing(false);
    }
  }, [t, toast]);
  const clearButtonLabel = isClearing
    ? t("settings.general.browserData.clearing")
    : t("settings.general.browserData.clear");

  return (
    <SettingsSection title={t("settings.general.browserData.title")}>
      {getIsElectron() && getDesktopHost()?.platform === "darwin" ? <CometImportSection /> : null}
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.browserData.siteData")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.browserData.description")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            loading={isClearing}
            disabled={isClearing}
            onPress={handleClear}
          >
            {clearButtonLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function CometImportSection() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const bridge = getDesktopHost()?.browser;
      if (!bridge?.listCometProfiles || !bridge.importCometProfile)
        throw new Error(t("settings.general.browserData.importUnavailable"));
      const available = await bridge.listCometProfiles();
      setProfiles(available);
      if (!available.length) throw new Error(t("settings.general.browserData.noCometProfiles"));
      const selected =
        available.find((profile) => profile.id === profileId) ??
        (available.length === 1 ? available[0] : null);
      if (!selected) {
        setProfileId(available[0].id);
        return;
      }
      const result = await bridge.importCometProfile({ profileId: selected.id });
      setMessage(
        t(
          result.status === "complete"
            ? "settings.general.browserData.importComplete"
            : "settings.general.browserData.importPartial",
        ) + (result.reason ? ` ${result.reason}` : ""),
      );
      setFailed(result.status === "partial");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
          : t("settings.general.browserData.importUnavailable"),
      );
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [profileId, t]);
  let buttonLabel = failed
    ? t("common.actions.retry")
    : t("settings.general.browserData.importComet");
  if (busy) buttonLabel = t("settings.general.browserData.importing");
  return (
    <View style={settingsStyles.card}>
      {profiles.length > 1 ? (
        <SettingsSelect
          label={t("settings.general.browserData.cometProfile")}
          value={profileId}
          options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
          onValueChange={setProfileId}
          disabled={busy}
        />
      ) : null}
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.general.browserData.importComet")}
          </Text>
          <Text style={settingsStyles.rowHint}>{t("settings.general.browserData.importHint")}</Text>
          {message ? (
            <Text accessibilityRole="alert" style={settingsStyles.rowHint}>
              {message}
            </Text>
          ) : null}
        </View>
        <Button variant="outline" size="sm" loading={busy} disabled={busy} onPress={run}>
          {buttonLabel}
        </Button>
      </View>
    </View>
  );
}
