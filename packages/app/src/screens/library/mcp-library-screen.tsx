import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, RefreshCw, Search, FolderSync } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";
import { useDefaultProjectId } from "@/hooks/use-default-project-id";
import {
  libraryKeys,
  useCreateLibraryEntry,
  useDeleteLibraryEntry,
  useLibraryEntries,
  useMcpCatalog,
  useSetLibraryActivation,
  useUpdateLibraryEntry,
} from "@/hooks/library/use-library-queries";
import { McpCard } from "@/components/library/mcp-card";
import { AddMcpModal, type AddMcpInitial } from "@/components/library/add-mcp-modal";
import { McpDetailModal } from "@/components/library/mcp-detail-modal";
import type { LibraryEntry } from "@/api/library";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { CatalogItem } from "@/api/catalog";
import { useSyncLibrary } from "@/hooks/library/use-sync-library";
import { SyncResultBanner } from "@/components/library/sync-result-banner";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { useWindowControlsPadding } from "@/utils/desktop-window";

export function McpLibraryScreen() {
  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const activeOrgId = useActiveOrgId();
  const activeProjectId = useDefaultProjectId();
  const qc = useQueryClient();
  const isCompact = useIsCompactFormFactor();

  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitial, setModalInitial] = useState<AddMcpInitial | undefined>();
  const [detailEntry, setDetailEntry] = useState<LibraryEntry | null>(null);
  const [editingEntry, setEditingEntry] = useState<LibraryEntry | null>(null);

  const installedQuery = useLibraryEntries(sessionToken, "mcp");
  const catalogQuery = useMcpCatalog(sessionToken, query);
  const createMutation = useCreateLibraryEntry(sessionToken);
  const updateMutation = useUpdateLibraryEntry(sessionToken);
  const deleteMutation = useDeleteLibraryEntry(sessionToken);
  const activationMutation = useSetLibraryActivation(sessionToken);
  const syncLibrary = useSyncLibrary(sessionToken);

  const installed = installedQuery.data ?? [];
  const catalogItems = catalogQuery.data?.items ?? [];

  const installedCatalogIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of installed) if (e.catalogId) s.add(e.catalogId);
    return s;
  }, [installed]);

  const openCustom = () => {
    setModalInitial(undefined);
    setModalOpen(true);
  };
  const openCatalog = (item: CatalogItem) => {
    setModalInitial({ fromCatalog: item, suggestedName: item.name });
    setModalOpen(true);
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: libraryKeys.all });
  };

  const windowPadding = useWindowControlsPadding("header");

  return (
    <View style={styles.page}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: windowPadding.top + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <SidebarMenuToggle />
            <Text style={styles.title}>MCP</Text>
          </View>
          <Text style={styles.subtitle}>
            Connect your agents with external data sources and tools
          </Text>
        </View>

        <View style={isCompact ? styles.searchInputWrapFull : styles.searchRow}>
          <View style={[styles.searchInputWrap, isCompact && styles.searchInputWrapGrow]}>
            <Search size={16} color="currentColor" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search servers..."
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
          {!isCompact ? (
            <ActionButtons
              onRefresh={refresh}
              onSync={syncLibrary.canSync ? () => void syncLibrary.sync() : null}
              syncPending={syncLibrary.pending}
              onCustom={openCustom}
            />
          ) : null}
        </View>
        {isCompact ? (
          <View style={styles.actionRowCompact}>
            <ActionButtons
              onRefresh={refresh}
              onSync={syncLibrary.canSync ? () => void syncLibrary.sync() : null}
              syncPending={syncLibrary.pending}
              onCustom={openCustom}
              compact
            />
          </View>
        ) : null}

        <SyncResultBanner error={syncLibrary.error} lastResult={syncLibrary.lastResult} />

        {installed.length > 0 ? (
          <Section label="Installed">
            <Grid compact={isCompact}>
              {installed.map((e) => (
                <McpCard
                  key={e.id}
                  name={e.displayName}
                  description={e.description ?? ""}
                  iconUrl={e.iconUrl}
                  transport={(e.payload as { transport?: "stdio" | "http" | "sse" }).transport}
                  installed
                  onPress={() => setDetailEntry(e)}
                />
              ))}
            </Grid>
          </Section>
        ) : null}

        <Section label={query.trim() ? "Results" : "Recommended"}>
          {catalogQuery.isError && catalogItems.length > 0 ? (
            <Text style={styles.syncWarnText}>Catalog offline — showing cached results.</Text>
          ) : null}
          {catalogQuery.isLoading && catalogItems.length === 0 ? (
            <View style={styles.loaderRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.loaderText}>Loading servers…</Text>
            </View>
          ) : catalogQuery.isError && catalogItems.length === 0 ? (
            <View style={styles.errorRow}>
              <Text style={styles.errorText}>Catalog temporarily unavailable.</Text>
            </View>
          ) : catalogItems.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>
                {query ? "No servers match your search." : "Nothing here yet."}
              </Text>
            </View>
          ) : (
            <Grid compact={isCompact}>
              {catalogItems.map((item) => (
                <McpCard
                  key={item.id}
                  name={item.name}
                  description={item.description}
                  iconUrl={item.iconUrl}
                  transport={item.transports?.[0]}
                  stars={item.popularity}
                  homepage={item.homepage}
                  installed={installedCatalogIds.has(item.id)}
                  onPress={() => openCatalog(item)}
                />
              ))}
            </Grid>
          )}
        </Section>
      </ScrollView>

      <AddMcpModal
        visible={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingEntry(null);
        }}
        onSubmit={async (input) => {
          let entryId: string;
          if (editingEntry) {
            const updated = await updateMutation.mutateAsync({
              entryId: editingEntry.id,
              displayName: input.displayName,
              description: input.description,
              payload: input.payload,
              visibility: input.visibility,
            });
            entryId = updated.id;
          } else {
            const created = await createMutation.mutateAsync({
              kind: "mcp",
              ...input,
            });
            entryId = created.id;
          }
          // Persist the sync target selection on the entry's activation row,
          // then auto-fan-out to every selected CLI/GUI target. Skipping the
          // activation call means `syncLibrary` would use whatever was saved
          // before — the user's picker changes would silently not apply.
          await activationMutation.mutateAsync({
            entryId,
            active: true,
            syncTargets: input.syncTargets,
          });
          if (input.syncTargets.length > 0) {
            await qc.refetchQueries({ queryKey: libraryKeys.all });
            await syncLibrary.sync();
          }
          setModalOpen(false);
          setEditingEntry(null);
        }}
        initial={modalInitial}
        editingEntry={editingEntry}
        activeOrgId={activeOrgId}
        activeProjectId={activeProjectId}
        submitting={createMutation.isPending || updateMutation.isPending}
      />

      <McpDetailModal
        visible={detailEntry !== null}
        onClose={() => setDetailEntry(null)}
        entry={detailEntry}
        onEdit={(entry) => {
          setDetailEntry(null);
          setEditingEntry(entry);
          setModalInitial(undefined);
          setModalOpen(true);
        }}
        onUninstall={async (entry) => {
          await deleteMutation.mutateAsync(entry.id);
          // Re-sync so every agent that held this entry drops it. The sync
          // writer diffs against the manifest and removes stale keys.
          await qc.refetchQueries({ queryKey: libraryKeys.all });
          await syncLibrary.sync();
          setDetailEntry(null);
        }}
        uninstallPending={deleteMutation.isPending}
      />
    </View>
  );
}

interface ActionButtonsProps {
  onRefresh: () => void;
  onSync: (() => void) | null;
  syncPending: boolean;
  onCustom: () => void;
  /** When true, buttons flex to fill the row equally (mobile). */
  compact?: boolean;
}

/**
 * Refresh / Sync / Custom MCP trio. Extracted so it can render inline in the
 * header on desktop and as its own row below the full-width search input on
 * mobile without duplicating props-passing.
 */
function ActionButtons({ onRefresh, onSync, syncPending, onCustom, compact }: ActionButtonsProps) {
  return (
    <>
      <Pressable
        onPress={onRefresh}
        style={({ hovered }) => [styles.iconBtn, hovered && styles.iconBtnHovered]}
        accessibilityRole="button"
        accessibilityLabel="Refresh"
      >
        <RefreshCw size={16} color="currentColor" />
      </Pressable>
      {onSync ? (
        <Pressable
          onPress={onSync}
          disabled={syncPending}
          style={({ hovered }) => [
            styles.customBtn,
            compact && styles.customBtnFlex,
            hovered && !syncPending && styles.customBtnHovered,
            syncPending && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Sync to local CLI configs"
        >
          <FolderSync size={16} color="currentColor" />
          <Text style={styles.customBtnLabel}>{syncPending ? "Syncing…" : "Sync"}</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={onCustom}
        style={({ hovered }) => [
          styles.customBtn,
          compact && styles.customBtnFlex,
          hovered && styles.customBtnHovered,
        ]}
        accessibilityRole="button"
      >
        <Plus size={16} color="currentColor" />
        <Text style={styles.customBtnLabel}>Custom MCP</Text>
      </Pressable>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Grid({ compact, children }: { compact: boolean; children: React.ReactNode }) {
  // Wrap each child in a flex basis cell so wide viewports lay out 2 columns
  // and compact falls back to stacked rows.
  const items = Array.isArray(children) ? children : [children];
  return (
    <View style={[styles.grid, !compact && styles.gridWide]}>
      {items.map((child, i) => (
        <View key={i} style={compact ? styles.gridCell : styles.gridCellWide}>
          {child}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    padding: theme.spacing[6],
    gap: theme.spacing[6],
    maxWidth: 1100,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    gap: theme.spacing[2],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: -theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize["3xl"],
    fontWeight: "700" as const,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Card grid below uses 48.8% per cell → right column ends at ~97.6%.
    // Mirror that here so the `Custom MCP` button sits flush with the card
    // edge instead of overshooting by ~20px.
    paddingRight: "1.4%",
  },
  searchInputWrapFull: {
    flexDirection: "row",
    alignItems: "center",
  },
  searchInputWrapGrow: {
    flex: 1,
  },
  actionRowCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  customBtnFlex: {
    flex: 1,
    justifyContent: "center",
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foregroundMuted,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  iconBtn: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foregroundMuted,
  },
  iconBtnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  customBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
  },
  customBtnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  customBtnLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  section: {
    gap: theme.spacing[3],
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.6,
  },
  grid: {
    gap: theme.spacing[2],
  },
  gridWide: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    // row gap handled by the wrapping View's gap token
  },
  gridCell: {
    width: "100%",
  },
  gridCellWide: {
    // Approx two-column: 48% leaves ~4% for row gap. Simple + works on
    // both native and react-native-web without `calc()`.
    width: "48.8%",
  },
  loaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
    justifyContent: "center",
  },
  loaderText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorRow: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  emptyRow: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  syncErrorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  syncWarnText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
