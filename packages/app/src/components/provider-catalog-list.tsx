import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PackagePlus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { SearchField } from "@/components/ui/search-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { rankProviderCatalog } from "@/components/provider-catalog-search";
import {
  useAcpProviderCatalog,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SPACING, type Theme } from "@/styles/theme";
import { settingsStyles } from "@/styles/settings";

interface ProviderCatalogListProps {
  serverId: string;
  installingProviderId: string | null;
  onInstall: (entry: AcpProviderCatalogItem) => Promise<void> | void;
}

const PROVIDER_FALLBACK_ICON_SIZE = 20;
const PROVIDER_REMOTE_ICON_SIZE = 24;
const TILE_GAP = SPACING[3];
/** Narrowest tile that keeps the icon, type badge, install link, and Add on one row. */
const MIN_TILE_WIDTH = 300;
const MAX_COLUMNS = 4;

const ThemedPackagePlus = withUnistyles(PackagePlus);
const ThemedSvgXml = withUnistyles(SvgXml);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function columnCountForWidth(width: number): number {
  const fits = Math.floor((width + TILE_GAP) / (MIN_TILE_WIDTH + TILE_GAP));
  return Math.min(MAX_COLUMNS, Math.max(1, fits));
}

interface CatalogTileProps {
  entry: AcpProviderCatalogItem;
  /** `undefined` until the grid is measured, or in a single column; the tile fills the row. */
  width: number | undefined;
  installing: boolean;
  onInstall: (entry: AcpProviderCatalogItem) => void;
}

function CatalogTile({ entry, width, installing, onInstall }: CatalogTileProps) {
  const { t } = useTranslation();
  const handleInstall = useCallback(() => {
    onInstall(entry);
  }, [entry, onInstall]);
  const tileStyle = useMemo(
    () => [settingsStyles.card, styles.tile, width === undefined ? styles.tileFull : { width }],
    [width],
  );

  return (
    <View style={tileStyle} testID={`provider-catalog-tile-${entry.id}`}>
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
      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={1}>
          {entry.title}
        </Text>
        <View style={styles.metaRow}>
          {/* The catalog is the ACP registry, so every entry it offers is an ACP provider. */}
          <StatusBadge label={t("providerCatalog.types.acp")} size="xs" />
          <ExternalLink
            href={entry.installLink}
            label={t("providerCatalog.actions.installInstructions")}
            accessibilityLabel={t("providerCatalog.actions.installInstructionsFor", {
              provider: entry.title,
            })}
          />
        </View>
      </View>
      <Button
        size="xs"
        variant="outline"
        disabled={installing}
        loading={installing}
        onPress={handleInstall}
        accessibilityLabel={t("providerCatalog.actions.addProvider", { provider: entry.title })}
        style={styles.addButton}
        testID={`install-provider-${entry.id}`}
      >
        {installing ? t("providerCatalog.actions.adding") : t("providerCatalog.actions.add")}
      </Button>
    </View>
  );
}

export function ProviderCatalogList({
  serverId,
  installingProviderId,
  onInstall,
}: ProviderCatalogListProps) {
  const { t } = useTranslation();
  const { entries: catalogEntries } = useAcpProviderCatalog();
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const [search, setSearch] = useState("");
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  const installedIds = useMemo(
    () => new Set(providerEntries?.map((entry) => entry.provider) ?? []),
    [providerEntries],
  );

  const availableEntries = useMemo(
    () =>
      rankProviderCatalog(
        catalogEntries.filter((entry) => !installedIds.has(entry.id)),
        search,
      ),
    [catalogEntries, installedIds, search],
  );

  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);

  const tileWidth = useMemo(() => {
    if (gridWidth === null) return undefined;
    const columns = columnCountForWidth(gridWidth);
    if (columns === 1) return undefined;
    return Math.floor((gridWidth - TILE_GAP * (columns - 1)) / columns);
  }, [gridWidth]);

  return (
    <View>
      <View style={styles.searchRail}>
        <SearchField
          value={search}
          onChangeText={setSearch}
          placeholder={t("providerCatalog.search")}
          clearAccessibilityLabel={t("providerCatalog.clearSearch")}
          testID="provider-catalog-search"
          clearTestID="provider-catalog-search-clear"
        />
      </View>

      {availableEntries.length === 0 ? (
        <View style={[settingsStyles.card, styles.stateBox]}>
          <Text style={styles.stateText}>{t("providerCatalog.noProviders")}</Text>
        </View>
      ) : (
        <View style={styles.grid} onLayout={handleGridLayout}>
          {availableEntries.map((entry) => (
            <CatalogTile
              key={entry.id}
              entry={entry}
              width={tileWidth}
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
  searchRail: {
    flexDirection: "row",
    marginBottom: theme.spacing[3],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: TILE_GAP,
  },
  tile: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  tileFull: {
    width: "100%",
  },
  details: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  iconFrame: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  addButton: {
    flexShrink: 0,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stateBox: {
    minHeight: 96,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
