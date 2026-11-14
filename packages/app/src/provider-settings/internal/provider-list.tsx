import { Plus } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useProviderInstallation } from "@/components/provider-installation";
import { SettingsAddRow, SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { AddProviderSheet } from "./add-provider-sheet";
import { useProviderConfigActions, type ProviderEntry } from "./provider-config";
import { ProviderGlyph } from "./provider-glyph";
import { ProviderRow } from "./provider-row";
import { readRowSummary } from "./row-summary";
import type { ProviderSheetFrame } from "./sheet-frame";

export interface ProviderListProps {
  serverId: string;
  /** Opens a provider's detail wherever the host shows it: a Settings page or a sheet. */
  onOpenProvider: (providerId: string) => void;
  /** Where the sheets the list opens sit. Defaults to a sheet over the current screen. */
  sheetFrame?: ProviderSheetFrame;
}

/** The host's providers, each saying how it is, and the way to add one. */
export function ProviderList({ serverId, onOpenProvider, sheetFrame }: ProviderListProps) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId) && serverId.length > 0;
  const { entries, isLoading } = useProvidersSnapshot(serverId);
  const { setEnabled, togglingProviderId } = useProviderConfigActions(serverId);
  const definitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const [adding, setAdding] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const handleAdded = useCallback(
    (providerId: string) => {
      setAdding(false);
      onOpenProvider(providerId);
    },
    [onOpenProvider],
  );

  const addButton = useMemo(
    () =>
      isConnected ? (
        <Button
          variant="ghost"
          leftIcon={Plus}
          onPress={openAdd}
          accessibilityLabel={t("settings.providers.addProvider")}
          testID="provider-list-add"
        >
          {t("settings.providers.list.add")}
        </Button>
      ) : null,
    [isConnected, openAdd, t],
  );

  let body: React.ReactNode;
  if (!isConnected) {
    body = (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
      </View>
    );
  } else if (isLoading) {
    body = <ProviderRowsSkeleton />;
  } else {
    body = (
      <SettingsCard testID="provider-list">
        {definitions.map((definition) => {
          const entry = entries?.find((candidate) => candidate.provider === definition.id);
          if (!entry) return null;
          return (
            <ListedProvider
              key={definition.id}
              serverId={serverId}
              entry={entry}
              label={definition.label}
              toggling={togglingProviderId === definition.id}
              onOpen={onOpenProvider}
              onToggle={setEnabled}
            />
          );
        })}
        <SettingsAddRow
          label={t("settings.providers.addProvider")}
          onPress={openAdd}
          testID="provider-list-add-row"
        />
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.providers.title")}
        trailing={addButton}
        testID="host-page-providers-card"
      >
        {body}
      </SettingsSection>
      {isConnected ? (
        <AddProviderSheet
          serverId={serverId}
          visible={adding}
          onClose={closeAdd}
          onAdded={handleAdded}
          frame={sheetFrame}
        />
      ) : null}
    </>
  );
}

/** A row reads its provider's installation itself; the detail shares the same requests. */
function ListedProvider({
  serverId,
  entry,
  label,
  toggling,
  onOpen,
  onToggle,
}: {
  serverId: string;
  entry: ProviderEntry;
  label: string;
  toggling: boolean;
  onOpen: (provider: string) => void;
  onToggle: (provider: string, enabled: boolean) => void;
}) {
  const installation = useProviderInstallation({
    serverId,
    provider: entry.provider,
    visible: true,
  });
  const icon = useMemo(
    () => <ProviderGlyph serverId={serverId} provider={entry.provider} />,
    [entry.provider, serverId],
  );
  return (
    <ProviderRow
      provider={entry.provider}
      label={label}
      icon={icon}
      summary={readRowSummary(entry, installation)}
      enabled={entry.enabled}
      toggling={toggling}
      onOpen={onOpen}
      onToggle={onToggle}
    />
  );
}

const SKELETON_ROW_KEYS = [0, 1, 2, 3].map((index) => `provider-skeleton-row-${index}`);

function ProviderRowsSkeleton() {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();
  return (
    <View
      style={settingsStyles.card}
      accessibilityLabel={t("settings.providers.loading")}
      testID="providers-skeleton"
    >
      {SKELETON_ROW_KEYS.map((key, index) => (
        <View key={key} style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}>
          <View style={styles.skeletonContent}>
            <SkeletonPulse pulse={pulse} style={styles.skeletonIcon} />
            <SkeletonPulse pulse={pulse} style={styles.skeletonTitle} />
          </View>
          <SkeletonPulse pulse={pulse} style={styles.skeletonSwitch} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  skeletonContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  skeletonIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  skeletonTitle: {
    width: 160,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSwitch: {
    width: 36,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
}));
