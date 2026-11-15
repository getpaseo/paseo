import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import type { PluginListingIndex, PluginListing } from "@getpaseo/protocol/plugin-registry";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { settingsStyles } from "@/styles/settings";
import { usePluginActions } from "./actions";
import { ListingInstallControl } from "./install-control";
import {
  ALL_CATEGORIES,
  categoryLabel,
  featuredListings,
  filterDirectory,
  formatInstallCount,
  listingAuthor,
  listingAuthorAvatar,
  listingImages,
  listingText,
  type DirectorySort,
} from "./listing";
import { usePluginOperation } from "./operations";
import { PluginMeta, PluginRow, PluginTile } from "./plugin-row";
import { usePluginDirectory } from "./queries";
import { buildPluginListingRoute } from "./routes";
import { PluginRowsSkeleton } from "./skeletons";
import { pluginErrorText } from "./error-text";

const SORTS: DirectorySort[] = ["popular", "recent", "name"];
// Below this width the featured grid has two columns instead of four.
const FEATURED_FOUR_COLUMNS = 760;
const LISTING_PAGE = 50;

/** "author · 1.1k installs". */
export function useListingMeta() {
  const { t } = useTranslation();
  return useCallback(
    (listing: PluginListing) =>
      listing.installs === undefined
        ? listingAuthor(listing)
        : `${listingAuthor(listing)} · ${t("settings.plugins.gallery.installs", {
            count: listing.installs,
            installs: formatInstallCount(listing.installs),
          })}`,
    [t],
  );
}

function ListingRow({
  serverId,
  listing,
  installedPlugin,
  uninstalling,
  onInstall,
  onUninstall,
}: {
  serverId: string;
  listing: PluginListing;
  installedPlugin?: PluginListItem;
  uninstalling: boolean;
  onInstall(listing: PluginListing): void;
  onUninstall(plugin: PluginListItem): void;
}) {
  const { i18n } = useTranslation();
  const meta = useListingMeta();
  const operation = usePluginOperation(serverId, listing.id);
  const { name, description } = listingText(listing, i18n.language);
  const open = useCallback(
    () => router.push(buildPluginListingRoute(serverId, listing.id)),
    [listing.id, serverId],
  );
  return (
    <PluginRow
      name={name}
      icon={listing.icon}
      description={description}
      meta={meta(listing)}
      authorAvatar={listingAuthorAvatar(listing)}
      error={!installedPlugin && operation?.status === "failed" ? operation.error : undefined}
      onPress={open}
      accessibilityLabel={name}
      testID={`plugin-listing-${listing.id}`}
    >
      <ListingInstallControl
        listing={listing}
        installedPlugin={installedPlugin}
        operation={operation}
        uninstalling={uninstalling}
        onInstall={onInstall}
        onUninstall={onUninstall}
      />
    </PluginRow>
  );
}

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function FeaturedCard({ serverId, listing }: { serverId: string; listing: PluginListing }) {
  const { i18n } = useTranslation();
  const meta = useListingMeta();
  const { name, description } = listingText(listing, i18n.language);
  const image = listingImages(listing)[0];
  const source = useMemo(() => (image ? { uri: image } : null), [image]);
  const open = useCallback(
    () => router.push(buildPluginListingRoute(serverId, listing.id)),
    [listing.id, serverId],
  );
  const cardStyle = useCallback(
    ({ hovered }: HoverState) => [styles.featured, hovered && styles.featuredHovered],
    [],
  );
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={open}
      style={cardStyle}
      highlightStyle={styles.featuredPressed}
      testID={`plugin-featured-${listing.id}`}
    >
      <View style={styles.media}>
        {source ? <Image source={source} style={styles.mediaImage} resizeMode="cover" /> : null}
      </View>
      <View style={styles.featuredBody}>
        <View style={styles.featuredTitle}>
          <PluginTile name={name} icon={listing.icon} />
          <Text style={styles.featuredName} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <Text style={styles.featuredDescription} numberOfLines={2}>
          {description}
        </Text>
        <PluginMeta text={meta(listing)} authorAvatar={listingAuthorAvatar(listing)} />
      </View>
    </PressHighlight>
  );
}

/** Every featured listing: a row to swipe on a phone, a grid of four or two columns otherwise. */
function Featured({ serverId, listings }: { serverId: string; listings: PluginListing[] }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const grid = useContainerWidthBelow(FEATURED_FOUR_COLUMNS, { initialIsBelow: false });
  const cellStyle = grid.isBelow ? styles.cellHalf : styles.cellQuarter;
  return (
    <SettingsSection title={t("settings.plugins.gallery.sections.featured")}>
      {compact ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.featuredRow}
        >
          {listings.map((listing) => (
            <View key={listing.id} style={styles.cellSwipe}>
              <FeaturedCard serverId={serverId} listing={listing} />
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.featuredGrid} onLayout={grid.onLayout}>
          {listings.map((listing) => (
            <View key={listing.id} style={cellStyle}>
              <FeaturedCard serverId={serverId} listing={listing} />
            </View>
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

function FilterOption<Value extends string>({
  option,
  selected,
  onChange,
}: {
  option: { value: Value; label: string };
  selected: boolean;
  onChange(value: Value): void;
}) {
  const select = useCallback(() => onChange(option.value), [onChange, option.value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {option.label}
    </DropdownMenuItem>
  );
}

function FilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  testID,
}: {
  label: string;
  value: Value;
  options: { value: Value; label: string }[];
  onChange(value: Value): void;
  testID: string;
}) {
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <DropdownMenu>
      <DropdownTrigger
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected}`}
        testID={testID}
      >
        {selected}
      </DropdownTrigger>
      <DropdownMenuContent side="bottom" align="start" width={220} sheetTitle={label}>
        {options.map((option) => (
          <FilterOption
            key={option.value}
            option={option}
            selected={option.value === value}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The listings in pages: the directory has hundreds, and rendering them all makes switching to
 * Browse and typing in search lag. A new query, category or sort starts again at the first page.
 */
function ListingList({
  serverId,
  listings,
  installed,
  onInstall,
}: {
  serverId: string;
  listings: PluginListing[];
  installed: ReadonlyMap<string, PluginListItem>;
  onInstall(listing: PluginListing): void;
}) {
  const { t } = useTranslation();
  const actions = usePluginActions(serverId);
  const uninstall = useCallback(
    (plugin: PluginListItem) => void actions.run("remove", plugin),
    [actions],
  );
  const [limit, setLimit] = useState(LISTING_PAGE);
  const showMore = useCallback(() => setLimit((value) => value + LISTING_PAGE), []);
  if (!listings.length)
    return (
      <SettingsCard testID="plugin-directory-list">
        <View style={styles.empty}>
          <Text style={settingsStyles.rowHint}>
            {t("settings.plugins.gallery.empty.noMatches")}
          </Text>
        </View>
      </SettingsCard>
    );
  return (
    <>
      <SettingsCard testID="plugin-directory-list">
        {listings.slice(0, limit).map((listing) => (
          <ListingRow
            key={listing.id}
            serverId={serverId}
            listing={listing}
            installedPlugin={installed.get(listing.id)}
            uninstalling={
              actions.pending?.action === "remove" &&
              actions.pending.pluginId === installed.get(listing.id)?.id
            }
            onInstall={onInstall}
            onUninstall={uninstall}
          />
        ))}
      </SettingsCard>
      {listings.length > limit ? (
        <View style={styles.more}>
          <Button variant="outline" onPress={showMore} testID="plugin-directory-more">
            {t("settings.plugins.gallery.actions.showMore")}
          </Button>
        </View>
      ) : null}
    </>
  );
}

function Directory({
  serverId,
  index,
  installed,
  query,
  onInstall,
}: {
  serverId: string;
  index: PluginListingIndex;
  installed: ReadonlyMap<string, PluginListItem>;
  query: string;
  onInstall(listing: PluginListing): void;
}) {
  const { t, i18n } = useTranslation();
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [sort, setSort] = useState<DirectorySort>("popular");
  const listings = filterDirectory(index, { query, category, sort }, i18n.language);
  const browsing = !query.trim() && category === ALL_CATEGORIES;
  const featured = browsing ? featuredListings(index) : [];
  const categoryOptions = useMemo(
    () => [
      { value: ALL_CATEGORIES, label: t("settings.plugins.gallery.filters.allCategories") },
      ...index.categories.map((entry) => ({ value: entry.slug, label: entry.label })),
    ],
    [index.categories, t],
  );
  const sortOptions = useMemo(
    (): { value: DirectorySort; label: string }[] =>
      SORTS.map((value) => ({ value, label: t(`settings.plugins.gallery.filters.${value}`) })),
    [t],
  );
  const listTitle =
    category === ALL_CATEGORIES
      ? t("settings.plugins.gallery.sections.all")
      : categoryLabel(index, category);
  return (
    <>
      <View style={styles.filters}>
        <FilterMenu
          label={t("settings.plugins.gallery.filters.category")}
          value={category}
          options={categoryOptions}
          onChange={setCategory}
          testID="plugin-category-filter"
        />
        <FilterMenu<DirectorySort>
          label={t("settings.plugins.gallery.filters.sort")}
          value={sort}
          options={sortOptions}
          onChange={setSort}
          testID="plugin-sort"
        />
      </View>
      {featured.length ? <Featured serverId={serverId} listings={featured} /> : null}
      <SettingsSection title={listTitle}>
        <ListingList
          key={`${query}\n${category}\n${sort}`}
          serverId={serverId}
          listings={listings}
          installed={installed}
          onInstall={onInstall}
        />
      </SettingsSection>
    </>
  );
}

export function BrowseTab({
  serverId,
  installed,
  query,
  onInstall,
}: {
  serverId: string;
  /** Installed plugins by the listing they came from. */
  installed: ReadonlyMap<string, PluginListItem>;
  query: string;
  onInstall(listing: PluginListing): void;
}) {
  const { t } = useTranslation();
  const directory = usePluginDirectory(serverId);
  const retry = useCallback(() => void directory.query.refetch(), [directory.query]);
  if (!directory.supported)
    return (
      <Alert size="sm" variant="warning" title={t("settings.plugins.gallery.directory.update")} />
    );
  if (directory.query.isError)
    return (
      <Alert
        size="sm"
        variant="error"
        title={t("settings.plugins.gallery.directory.errorTitle")}
        description={pluginErrorText(directory.query.error)}
      >
        <Button variant="outline" onPress={retry}>
          {t("settings.plugins.states.retry")}
        </Button>
      </Alert>
    );
  if (!directory.query.data) return <PluginRowsSkeleton testID="plugin-directory-loading" />;
  return (
    <Directory
      serverId={serverId}
      index={directory.query.data}
      installed={installed}
      query={query}
      onInstall={onInstall}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[6],
  },
  featuredRow: { flexDirection: "row", gap: theme.spacing[3] },
  // Percent widths and a gap would overflow the row, so each cell carries half the gap on each side
  // and the grid pulls out by the same amount to keep the cards on the section's edges.
  featuredGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -theme.spacing[3] / 2,
    marginBottom: -theme.spacing[3],
  },
  cellQuarter: {
    width: "25%",
    paddingHorizontal: theme.spacing[3] / 2,
    marginBottom: theme.spacing[3],
  },
  cellHalf: {
    width: "50%",
    paddingHorizontal: theme.spacing[3] / 2,
    marginBottom: theme.spacing[3],
  },
  cellSwipe: { width: 260 },
  featured: {
    flexGrow: 1,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  featuredHovered: { backgroundColor: theme.colors.surface2 },
  featuredPressed: { backgroundColor: theme.colors.surface3 },
  media: {
    aspectRatio: 16 / 10,
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  mediaImage: { width: "100%", height: "100%" },
  featuredBody: { padding: theme.spacing[3], gap: theme.spacing[1] },
  featuredTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  featuredName: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  featuredDescription: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: { padding: theme.spacing[6], alignItems: "center" },
  more: { alignItems: "center", marginTop: theme.spacing[3] },
}));
