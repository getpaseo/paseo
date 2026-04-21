import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, RefreshCw, Search, FolderSync } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";
import {
  libraryKeys,
  useCreateLibraryEntry,
  useDeleteLibraryEntry,
  useLibraryEntries,
  useSkillsCatalog,
} from "@/hooks/library/use-library-queries";
import { SkillCard } from "@/components/library/skill-card";
import { AddSkillModal, type AddSkillInitial } from "@/components/library/add-skill-modal";
import { SkillDetailModal } from "@/components/library/skill-detail-modal";
import type { LibraryEntry } from "@/api/library";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { CatalogItem } from "@/api/catalog";
import { useSyncLibrary } from "@/hooks/library/use-sync-library";
import { SyncResultBanner } from "@/components/library/sync-result-banner";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { useWindowControlsPadding } from "@/utils/desktop-window";

export function SkillsLibraryScreen() {
  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;
  const activeOrgId = useActiveOrgId();
  const qc = useQueryClient();
  const isCompact = useIsCompactFormFactor();

  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitial, setModalInitial] = useState<AddSkillInitial | undefined>();

  const installedQuery = useLibraryEntries(sessionToken, "skill");
  const catalogQuery = useSkillsCatalog(sessionToken, query);
  const createMutation = useCreateLibraryEntry(sessionToken);
  const deleteMutation = useDeleteLibraryEntry(sessionToken);
  const syncLibrary = useSyncLibrary(sessionToken);
  const [detailEntry, setDetailEntry] = useState<LibraryEntry | null>(null);

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
            <Text style={styles.title}>Skills</Text>
          </View>
          <Text style={styles.subtitle}>
            Reusable instructions your agents can load on demand
          </Text>
        </View>

        <View style={isCompact ? styles.searchInputWrapFull : styles.searchRow}>
          <View style={[styles.searchInputWrap, isCompact && styles.searchInputWrapGrow]}>
            <Search size={16} color="currentColor" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search skills..."
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
              customLabel="New Skill"
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
              customLabel="New Skill"
              compact
            />
          </View>
        ) : null}

        <SyncResultBanner
          error={syncLibrary.error}
          lastResult={syncLibrary.lastResult}
        />

        {installed.length > 0 ? (
          <Section label="Installed">
            <Grid compact={isCompact}>
              {installed.map((e) => (
                <SkillCard
                  key={e.id}
                  name={e.displayName}
                  description={e.description ?? ""}
                  iconUrl={e.iconUrl}
                  installed
                  onPress={() => setDetailEntry(e)}
                />
              ))}
            </Grid>
          </Section>
        ) : null}

        <Section label={query.trim() ? "Results" : "Recommended"}>
          {catalogQuery.isError && catalogItems.length > 0 ? (
            <Text style={styles.syncWarnText}>
              Catalog offline — showing cached results.
            </Text>
          ) : null}
          {catalogQuery.isLoading && catalogItems.length === 0 ? (
            <View style={styles.loaderRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.loaderText}>Loading skills…</Text>
            </View>
          ) : catalogQuery.isError && catalogItems.length === 0 ? (
            <View style={styles.errorRow}>
              <Text style={styles.errorText}>Catalog temporarily unavailable.</Text>
            </View>
          ) : catalogItems.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>
                {query ? "No skills match your search." : "Nothing here yet."}
              </Text>
            </View>
          ) : (
            <Grid compact={isCompact}>
              {catalogItems.map((item) => (
                <SkillCard
                  key={item.id}
                  name={item.name}
                  description={item.description}
                  iconUrl={item.iconUrl}
                  popularity={item.popularity}
                  installed={installedCatalogIds.has(item.id)}
                  onPress={() => openCatalog(item)}
                />
              ))}
            </Grid>
          )}
        </Section>
      </ScrollView>

      <AddSkillModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={async (input) => {
          await createMutation.mutateAsync({
            kind: "skill",
            ...input,
          });
          setModalOpen(false);
        }}
        initial={modalInitial}
        activeOrgId={activeOrgId}
        activeProjectId={null}
        submitting={createMutation.isPending}
      />

      <SkillDetailModal
        visible={detailEntry !== null}
        onClose={() => setDetailEntry(null)}
        entry={detailEntry}
        onUninstall={async (entry) => {
          await deleteMutation.mutateAsync(entry.id);
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
  customLabel: string;
  compact?: boolean;
}

function ActionButtons({
  onRefresh,
  onSync,
  syncPending,
  onCustom,
  customLabel,
  compact,
}: ActionButtonsProps) {
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
          <Text style={styles.customBtnLabel}>
            {syncPending ? "Syncing…" : "Sync"}
          </Text>
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
        <Text style={styles.customBtnLabel}>{customLabel}</Text>
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
  },
  gridCell: {
    width: "100%",
  },
  gridCellWide: {
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
