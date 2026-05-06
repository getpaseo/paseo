import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, PackagePlus, Search } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  buildAcpProviderConfigPatch,
  useAcpProviderCatalog,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

interface AddProviderModalProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}

type InstallState = "installed" | "available";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const ACTION_BUTTON_STYLE = { width: 92 } as const;
const MODAL_SNAP_POINTS = ["78%", "92%"];
const SEARCH_ICON_SIZE = 16;
const PROVIDER_FALLBACK_ICON_SIZE = 20;
const PROVIDER_REMOTE_ICON_SIZE = 24;

const ThemedPackagePlus = withUnistyles(PackagePlus);
const ThemedSvgXml = withUnistyles(SvgXml);
const ThemedSearch = withUnistyles(Search);
const ThemedExternalLink = withUnistyles(ExternalLink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function getInstallState(
  entry: AcpProviderCatalogItem,
  installedProviderIds: Set<string>,
): InstallState {
  if (installedProviderIds.has(entry.id)) return "installed";
  return "available";
}

function matchesSearch(entry: AcpProviderCatalogItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [entry.title, entry.id, entry.description].some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

interface ProviderCatalogRowProps {
  entry: AcpProviderCatalogItem;
  state: InstallState;
  installing: boolean;
  onInstall: (entry: AcpProviderCatalogItem) => void;
}

function ProviderCatalogRow({ entry, state, installing, onInstall }: ProviderCatalogRowProps) {
  const isAvailable = state === "available";
  let actionLabel = "Add";
  if (installing) {
    actionLabel = "Adding";
  } else if (state === "installed") {
    actionLabel = "Installed";
  }

  const handleInstall = useCallback(() => {
    onInstall(entry);
  }, [entry, onInstall]);

  const handleOpenInstallLink = useCallback(() => {
    void openExternalUrl(entry.installLink);
  }, [entry.installLink]);

  return (
    <View style={styles.row}>
      <View style={styles.iconFrame}>
        {entry.iconSvg ? (
          <ThemedSvgXml
            xml={entry.iconSvg}
            width={PROVIDER_REMOTE_ICON_SIZE}
            height={PROVIDER_REMOTE_ICON_SIZE}
            uniProps={foregroundColorMapping}
          />
        ) : (
          <ThemedPackagePlus size={PROVIDER_FALLBACK_ICON_SIZE} uniProps={foregroundColorMapping} />
        )}
      </View>
      <View style={styles.textColumn}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.title}
          </Text>
          <Text style={styles.version} numberOfLines={1}>
            {entry.version}
          </Text>
        </View>
        <Text style={styles.description} numberOfLines={1}>
          {entry.description || entry.id}
        </Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${entry.title} install instructions`}
          onPress={handleOpenInstallLink}
          style={styles.installLink}
        >
          <Text style={styles.installLinkText} numberOfLines={1}>
            Install instructions
          </Text>
          <ThemedExternalLink size={12} uniProps={foregroundMutedColorMapping} />
        </Pressable>
      </View>
      <Button
        size="sm"
        variant={isAvailable ? "default" : "secondary"}
        disabled={!isAvailable || installing}
        loading={installing}
        onPress={handleInstall}
        style={ACTION_BUTTON_STYLE}
        testID={`install-provider-${entry.id}`}
      >
        {actionLabel}
      </Button>
    </View>
  );
}

export function AddProviderModal({ serverId, visible, onClose }: AddProviderModalProps) {
  const { entries } = useAcpProviderCatalog();
  const { entries: providerEntries, refresh } = useProvidersSnapshot(serverId);
  const { patchConfig } = useDaemonConfig(serverId);
  const [search, setSearch] = useState("");
  const [installingProviderId, setInstallingProviderId] = useState<string | null>(null);

  const installedProviderIds = useMemo(
    () => new Set(providerEntries?.map((entry) => entry.provider) ?? []),
    [providerEntries],
  );
  const filteredEntries = useMemo(
    () => entries.filter((entry) => matchesSearch(entry, search)),
    [entries, search],
  );

  const handleInstall = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (installingProviderId) return;

      setInstallingProviderId(entry.id);
      try {
        await patchConfig(buildAcpProviderConfigPatch(entry));
        await refresh([entry.id]);
        onClose();
      } catch (installError) {
        Alert.alert(
          "Unable to install provider",
          installError instanceof Error ? installError.message : String(installError),
        );
      } finally {
        setInstallingProviderId((current) => (current === entry.id ? null : current));
      }
    },
    [installingProviderId, onClose, patchConfig, refresh],
  );

  return (
    <AdaptiveModalSheet
      title="Add provider"
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={680}
      snapPoints={MODAL_SNAP_POINTS}
      testID="add-provider-modal"
    >
      <View style={styles.searchField}>
        <View style={styles.searchIcon}>
          <ThemedSearch size={SEARCH_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
        </View>
        <AdaptiveTextInput
          testID="provider-catalog-search"
          accessibilityLabel="Search providers"
          value={search}
          onChangeText={setSearch}
          placeholder="Search providers"
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {filteredEntries.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.stateText}>No providers found</Text>
        </View>
      ) : null}

      {filteredEntries.length > 0 ? (
        <View style={styles.list}>
          {filteredEntries.map((entry) => (
            <ProviderCatalogRow
              key={entry.id}
              entry={entry}
              state={getInstallState(entry, installedProviderIds)}
              installing={installingProviderId === entry.id}
              onInstall={handleInstall}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button style={FLEX_ONE_STYLE} variant="secondary" onPress={onClose}>
          Cancel
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
  },
  searchIcon: {
    width: 18,
    alignItems: "center",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  list: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  iconFrame: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  version: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  installLink: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: "100%",
  },
  installLinkText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stateBox: {
    minHeight: 96,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
  },
}));
