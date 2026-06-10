import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, PackagePlus, Search } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  useAcpProviderCatalog,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

interface ProviderCatalogListProps {
  serverId: string;
  installingProviderId: string | null;
  onInstall: (entry: AcpProviderCatalogItem) => Promise<void> | void;
}

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

function matchesSearch(entry: AcpProviderCatalogItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [entry.title, entry.id, entry.description].some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

interface CatalogRowProps {
  entry: AcpProviderCatalogItem;
  installing: boolean;
  onInstall: (entry: AcpProviderCatalogItem) => void;
}

function CatalogRow({ entry, installing, onInstall }: CatalogRowProps) {
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
        variant="default"
        disabled={installing}
        loading={installing}
        onPress={handleInstall}
        style={styles.actionButton}
        testID={`install-provider-${entry.id}`}
      >
        {installing ? "Adding" : "Add"}
      </Button>
    </View>
  );
}

export function ProviderCatalogList({
  serverId,
  installingProviderId,
  onInstall,
}: ProviderCatalogListProps) {
  const { entries: catalogEntries } = useAcpProviderCatalog();
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const [search, setSearch] = useState("");

  const installedIds = useMemo(
    () => new Set(providerEntries?.map((entry) => entry.provider) ?? []),
    [providerEntries],
  );

  const availableEntries = useMemo(
    () =>
      catalogEntries
        .filter((entry) => !installedIds.has(entry.id))
        .filter((entry) => matchesSearch(entry, search)),
    [catalogEntries, installedIds, search],
  );

  return (
    <View>
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

      {availableEntries.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.stateText}>
            {search.trim().length > 0 ? "No providers found" : "All providers are installed"}
          </Text>
        </View>
      ) : (
        <View style={styles.list}>
          {availableEntries.map((entry) => (
            <CatalogRow
              key={entry.id}
              entry={entry}
              installing={installingProviderId === entry.id}
              onInstall={onInstall}
            />
          ))}
        </View>
      )}
    </View>
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
    marginBottom: theme.spacing[3],
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
  actionButton: {
    width: 92,
    flexShrink: 0,
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
}));
