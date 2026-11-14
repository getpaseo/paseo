import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { ProviderInstallationSection } from "@/components/provider-installation-section";
import { useProviderInstallation } from "@/components/provider-installation";
import {
  SettingsCard,
  SettingsDetailRow,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { readDetailPresence, readDetailSections, type DetailPresence } from "./detail-sections";
import { DiagnosticSheet } from "./diagnostic-sheet";
import { useProviderConfigActions, type ProviderEntry } from "./provider-config";
import { ProviderModels } from "./provider-models";
import { ProviderNotice } from "./provider-notice";

export interface ProviderDetailProps {
  serverId: string;
  provider: string;
  /** The provider was removed; leave its detail. */
  onRemoved: () => void;
}

/**
 * Everything about one provider, top to bottom: what is wrong, whether it runs, its installation,
 * its models, then the rare actions. The page and the sheet frame the same body.
 */
export function ProviderDetail({ serverId, provider, onRemoved }: ProviderDetailProps) {
  const { entries, error, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const installation = useProviderInstallation({ serverId, provider, visible: true });
  const refreshInstallation = installation.refresh;
  const handleRefresh = useCallback(() => {
    void refresh([provider]);
    refreshInstallation();
  }, [provider, refresh, refreshInstallation]);
  const label = resolveProviderLabel(provider, entries);
  const { canRemove, remove, removingProviderId } = useProviderConfigActions(serverId);
  // Kept once Remove succeeds, until the frame closes the page.
  const [removedProvider, setRemovedProvider] = useState<string | null>(null);
  const handleRemove = useCallback(() => {
    void remove(provider, label).then((removed) => {
      if (!removed) return removed;
      setRemovedProvider(provider);
      onRemoved();
      return removed;
    });
  }, [label, onRemoved, provider, remove]);
  const removingHere = removingProviderId === provider || removedProvider === provider;
  const presence = readDetailPresence({ provider, connected, entries, error, removingHere });
  if (presence.kind === "removed") return null;
  if (presence.kind !== "found") return <AbsentProvider presence={presence} />;

  const entry = presence.entry;
  const sections = readDetailSections(entry, installation.state);

  return (
    <View testID="provider-detail">
      {sections.error !== null ? <ProviderErrorAlert label={label} error={sections.error} /> : null}
      <EnabledCard serverId={serverId} entry={entry} />
      <ProviderInstallationSection
        state={installation.state}
        updates={installation.updates}
        action={installation.action}
      />
      {sections.models ? (
        <ProviderModels serverId={serverId} entry={entry} refresh={refresh} />
      ) : null}
      <Troubleshooting
        serverId={serverId}
        entry={entry}
        refreshing={isRefreshing || installation.refreshing}
        onRefresh={handleRefresh}
      />
      {canRemove(entry) ? (
        <DangerZone removing={removingProviderId === provider} onRemove={handleRemove} />
      ) : null}
    </View>
  );
}

function AbsentProvider({
  presence,
}: {
  presence: Exclude<DetailPresence, { kind: "found" | "removed" }>;
}) {
  const { t } = useTranslation();
  const messages = {
    loading: t("settings.providers.loading"),
    missing: t("settings.providers.detail.notOnHost"),
    offline: t("settings.providers.unavailable"),
  };
  const message = presence.kind === "failed" ? presence.message : messages[presence.kind];
  return <ProviderNotice message={message} testID={`provider-detail-${presence.kind}`} />;
}

function ProviderErrorAlert({ label, error }: { label: string; error: string }) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.section}>
      <Alert
        variant="error"
        title={t("settings.providers.detail.unavailableTitle", { name: label })}
        description={error || t("settings.providers.diagnostic.unknownError")}
        testID="provider-error"
      />
    </View>
  );
}

function EnabledCard({ serverId, entry }: { serverId: string; entry: ProviderEntry }) {
  const { t } = useTranslation();
  const { setEnabled, togglingProviderId } = useProviderConfigActions(serverId);
  const handleChange = useCallback(
    (enabled: boolean) => setEnabled(entry.provider, enabled),
    [entry.provider, setEnabled],
  );
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.providers.detail.enabled")}
          value={entry.enabled}
          onValueChange={handleChange}
          disabled={togglingProviderId === entry.provider}
        />
      </SettingsCard>
    </View>
  );
}

function Troubleshooting({
  serverId,
  entry,
  refreshing,
  onRefresh,
}: {
  serverId: string;
  entry: ProviderEntry;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const openDiagnostic = useCallback(() => setDiagnosticOpen(true), []);
  const closeDiagnostic = useCallback(() => setDiagnosticOpen(false), []);
  const checked = useTimeAgo(entry.fetchedAt ? new Date(entry.fetchedAt) : null);
  // The probe running again is a refresh too, whoever asked for it.
  const busy = refreshing || entry.status === "loading";

  return (
    <SettingsSection title={t("settings.providers.detail.troubleshooting")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.providers.detail.status")}
          hint={
            entry.fetchedAt ? t("settings.providers.detail.checked", { time: checked }) : undefined
          }
        >
          <Button variant="outline" onPress={onRefresh} loading={busy} testID="provider-refresh">
            {busy
              ? t("settings.providers.diagnostic.refreshing")
              : t("settings.providers.diagnostic.refresh")}
          </Button>
        </SettingsRow>
        <SettingsDetailRow
          label={t("settings.providers.detail.diagnosticReport")}
          onPress={openDiagnostic}
          testID="provider-diagnostic-report"
        />
      </SettingsCard>
      <DiagnosticSheet
        serverId={serverId}
        provider={entry.provider}
        visible={diagnosticOpen}
        onClose={closeDiagnostic}
      />
    </SettingsSection>
  );
}

function DangerZone({ removing, onRemove }: { removing: boolean; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.providers.detail.dangerZone")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.providers.actions.remove")}
          hint={t("settings.providers.detail.removeHint")}
        >
          <Button variant="outline" onPress={onRemove} disabled={removing} testID="provider-remove">
            {t("settings.providers.remove.confirm")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
