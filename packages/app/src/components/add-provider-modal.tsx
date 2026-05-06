import { useCallback, useMemo, useState } from "react";
import { Alert, Image, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PackagePlus, Search } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  buildAcpProviderConfigPatch,
  useAcpRegistry,
  type AcpRegistryEntry,
} from "@/hooks/use-acp-registry";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

interface AddProviderModalProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}

type InstallState = "installed" | "installable" | "binary";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const MODAL_SNAP_POINTS = ["78%", "92%"];

function getInstallState(entry: AcpRegistryEntry, installedProviderIds: Set<string>): InstallState {
  if (installedProviderIds.has(entry.id)) return "installed";
  if (entry.npx) return "installable";
  return "binary";
}

function matchesSearch(entry: AcpRegistryEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [entry.name, entry.id, entry.description].some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

interface ProviderRegistryRowProps {
  entry: AcpRegistryEntry;
  state: InstallState;
  installing: boolean;
  onInstall: (entry: AcpRegistryEntry) => void;
}

function ProviderRegistryRow({ entry, state, installing, onInstall }: ProviderRegistryRowProps) {
  const { theme } = useUnistyles();
  const [iconFailed, setIconFailed] = useState(false);
  const isInstallable = state === "installable";

  const handleInstall = useCallback(() => {
    onInstall(entry);
  }, [entry, onInstall]);
  const handleIconError = useCallback(() => setIconFailed(true), []);

  const iconSource = useMemo(
    () => (entry.iconUri && !iconFailed ? { uri: entry.iconUri } : null),
    [entry.iconUri, iconFailed],
  );

  return (
    <View style={styles.row}>
      <View style={styles.iconFrame}>
        {iconSource ? (
          <Image
            source={iconSource}
            style={styles.iconImage}
            resizeMode="contain"
            onError={handleIconError}
          />
        ) : (
          <PackagePlus size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
        )}
      </View>
      <View style={styles.textColumn}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={styles.version} numberOfLines={1}>
            {entry.version}
          </Text>
        </View>
        <Text style={styles.description} numberOfLines={1}>
          {entry.description || entry.id}
        </Text>
        {state === "binary" ? (
          <Text style={styles.helper} numberOfLines={2}>
            Install the binary on your PATH, then add manually.
          </Text>
        ) : null}
      </View>
      <Button
        size="sm"
        variant={isInstallable ? "default" : "secondary"}
        disabled={!isInstallable || installing}
        loading={installing}
        onPress={handleInstall}
        testID={`install-provider-${entry.id}`}
      >
        {state === "installed" ? "Installed" : "Install"}
      </Button>
    </View>
  );
}

export function AddProviderModal({ serverId, visible, onClose }: AddProviderModalProps) {
  const { theme } = useUnistyles();
  const { entries, loading, error, refetch } = useAcpRegistry();
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
  const searchIcon = useMemo(
    () => <Search size={16} color={theme.colors.foregroundMuted} />,
    [theme.colors.foregroundMuted],
  );

  const handleInstall = useCallback(
    async (entry: AcpRegistryEntry) => {
      if (!entry.npx || installingProviderId) return;

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

  const handleRefetch = useCallback(() => {
    void refetch();
  }, [refetch]);

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
        <View style={styles.searchIcon}>{searchIcon}</View>
        <AdaptiveTextInput
          testID="provider-registry-search"
          accessibilityLabel="Search providers"
          value={search}
          onChangeText={setSearch}
          placeholder="Search providers"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {loading ? (
        <View style={styles.stateBox}>
          <LoadingSpinner size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.stateText}>Loading providers...</Text>
        </View>
      ) : null}

      {!loading && error ? (
        <View style={styles.stateBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Button size="sm" variant="secondary" onPress={handleRefetch}>
            Retry
          </Button>
        </View>
      ) : null}

      {!loading && !error && filteredEntries.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.stateText}>No providers found</Text>
        </View>
      ) : null}

      {!loading && !error && filteredEntries.length > 0 ? (
        <View style={styles.list}>
          {filteredEntries.map((entry) => (
            <ProviderRegistryRow
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
  iconImage: {
    width: 24,
    height: 24,
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
  helper: {
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
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
  },
}));
