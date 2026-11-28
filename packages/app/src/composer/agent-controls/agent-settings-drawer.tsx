import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Pencil } from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type {
  AgentProfile,
  AgentProfilePicker,
  AgentProfilePickerRow,
  AgentProfileSeed,
} from "@/agent-profiles";
import {
  AdaptiveModalSheet,
  SheetHeaderIconButton,
  type SheetHeader,
  type SheetKeyboard,
} from "@/components/adaptive-modal-sheet";
import { ModelSearchNoMatches } from "@/components/model-browser";
import { ModelPickerItemRow, type ModelPickerActions } from "@/components/model-browser-panes";
import type { ModelPickerListItem } from "@/components/model-browser-panes-view";
import {
  MobileModelPageView,
  SHEET_LIST_CARD_LIST,
  SheetListCard,
  SheetSearchDock,
  useMobileModelPage,
} from "@/components/mobile-model-page";
import { SettingsCard, SettingsDetailRow } from "@/components/settings";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { FlatList as SheetFlatList } from "@/components/ui/scroll-view";
import { isNative } from "@/constants/platform";
import type { KeyboardInputEvent } from "@/keyboard";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  AGENT_SHEET_HOME,
  projectAgentSheetProfiles,
  resolveAgentSheetEscape,
  type AgentSheetPage,
} from "./model-sheet-flow";
import {
  AgentSheetHome,
  AgentSheetSelectPage,
  selectPageIsSearchable,
  selectPageTitle,
  type AgentSheetControls,
} from "./sheet-home";

const SNAP_POINTS = ["80%", "90%"];
const ESCAPE_KEYS = ["Escape"] as const;
const KEYBOARD_DISMISS_MODE = isNative ? "on-drag" : "none";
const NO_PROFILE_ROWS: AgentProfilePickerRow[] = [];

export interface AgentSettingsDrawerProps {
  visible: boolean;
  onClose: () => void;
  contextBridge: ContextBridge | null;
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  selectedModelLabel: string;
  canSwitchProvider: boolean;
  serverId: string | null;
  disabled: boolean;
  controls: AgentSheetControls;
  /** Drawn below the controls on Home. */
  pluginItems: ReactNode;
  profiles: AgentProfilePicker | null;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}

/**
 * The compact agent settings: one drawer whose page changes in place. Home lays out every control;
 * Model, Profiles and a long select each take the drawer over with a way back to Home.
 */
export function AgentSettingsDrawer({
  visible,
  onClose,
  contextBridge,
  providers,
  selectedProvider,
  selectedModel,
  selectedModelLabel,
  canSwitchProvider,
  serverId,
  disabled,
  controls,
  pluginItems,
  profiles,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider,
}: AgentSettingsDrawerProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState<AgentSheetPage>(AGENT_SHEET_HOME);
  // The Profiles and select pages search with this; the Model page keeps its own.
  const [pageQuery, setPageQuery] = useState("");
  const [pageSearchKey, setPageSearchKey] = useState(0);
  const modelPage = useMobileModelPage({ providers, selectedProvider, selectedModel });

  const goTo = useCallback((next: AgentSheetPage) => {
    Keyboard.dismiss();
    setPageQuery("");
    setPageSearchKey((key) => key + 1);
    setPage(next);
  }, []);
  const goHome = useCallback(() => goTo(AGENT_SHEET_HOME), [goTo]);
  const openModel = useCallback(() => {
    modelPage.reset();
    goTo({ kind: "model" });
  }, [goTo, modelPage]);
  const openProfiles = useCallback(() => goTo({ kind: "profiles" }), [goTo]);
  const openSelect = useCallback(
    (controlId: string) => goTo({ kind: "select", controlId }),
    [goTo],
  );

  const close = useCallback(() => {
    Keyboard.dismiss();
    setPage(AGENT_SHEET_HOME);
    setPageQuery("");
    modelPage.reset();
    onClose();
  }, [modelPage, onClose]);

  const clearPageQuery = useCallback(() => {
    setPageQuery("");
    setPageSearchKey((key) => key + 1);
  }, []);

  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: ESCAPE_KEYS,
      onKeyDown: (event: KeyboardInputEvent) => {
        if (event.key !== "Escape") return false;
        const query = page.kind === "model" ? modelPage.query : pageQuery;
        const step = resolveAgentSheetEscape({ page, query });
        if (step === "close") return false;
        if (step === "home") goHome();
        else if (page.kind === "model") modelPage.clearQuery();
        else clearPageQuery();
        return true;
      },
    }),
    [clearPageQuery, goHome, modelPage, page, pageQuery],
  );

  const handlePickModel = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      goHome();
    },
    [goHome, onSelect],
  );
  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );
  const handleEditProfiles = useCallback(() => {
    close();
    onEditProfiles?.();
  }, [close, onEditProfiles]);
  const handleCreateProfile = useCallback(
    (seed: AgentProfileSeed) => {
      if (seed.modelId) onSelect(seed.provider, seed.modelId);
      close();
      void onCreateProfile?.(seed);
    },
    [close, onCreateProfile, onSelect],
  );
  const handleEditProfile = useCallback(
    (profileId: string) => {
      close();
      onEditProfile?.(profileId);
    },
    [close, onEditProfile],
  );
  const pickerActions = useMemo<ModelPickerActions>(
    () => ({
      onSelect: handlePickModel,
      onApplyProfile: handleApplyProfile,
      onEditProfiles: onEditProfiles ? handleEditProfiles : undefined,
      onCreateProfile: onCreateProfile ? handleCreateProfile : undefined,
      onEditProfile: onEditProfile ? handleEditProfile : undefined,
      onRetryProvider,
      isRetryingProvider,
    }),
    [
      handleApplyProfile,
      handleCreateProfile,
      handleEditProfile,
      handleEditProfiles,
      handlePickModel,
      isRetryingProvider,
      onCreateProfile,
      onEditProfile,
      onEditProfiles,
      onRetryProvider,
    ],
  );

  const header = useMemo<SheetHeader>(() => {
    const back = { onPress: goHome };
    switch (page.kind) {
      case "home":
        return { title: t("agentControls.sheet.title") };
      case "model":
        return { title: t("modelSelector.model"), back };
      case "profiles":
        return {
          title: t("modelSelector.profiles"),
          back,
          actions: onEditProfiles ? (
            <SheetHeaderIconButton
              icon={Pencil}
              label={t("modelSelector.editProfilesLabel")}
              onPress={handleEditProfiles}
              testID="agent-controls-edit-profiles"
            />
          ) : undefined,
        };
      case "select":
        return {
          title: selectPageTitle(page.controlId, controls, t("agentControls.mode.title")),
          back,
        };
    }
  }, [controls, goHome, handleEditProfiles, onEditProfiles, page, t]);

  const footer = useMemo(() => {
    switch (page.kind) {
      case "home":
        return null;
      case "model":
        return (
          <SheetSearchDock
            query={modelPage.query}
            searchKey={modelPage.searchKey}
            onChangeText={modelPage.setQuery}
            placeholder={
              canSwitchProvider
                ? t("modelSelector.searchAllPlaceholder")
                : t("modelSelector.searchPlaceholder")
            }
            testID="model-search-all-input"
          />
        );
      case "profiles":
        return (profiles?.rows.length ?? 0) > 0 ? (
          <SheetSearchDock
            query={pageQuery}
            searchKey={pageSearchKey}
            onChangeText={setPageQuery}
            placeholder={t("modelSelector.searchProfilesPlaceholder")}
            testID="agent-controls-profiles-search"
          />
        ) : null;
      case "select":
        return selectPageIsSearchable(page.controlId, controls) ? (
          <SelectSearchDock
            controlId={page.controlId}
            controls={controls}
            query={pageQuery}
            searchKey={pageSearchKey}
            onChangeText={setPageQuery}
          />
        ) : null;
    }
  }, [
    canSwitchProvider,
    controls,
    modelPage.query,
    modelPage.searchKey,
    modelPage.setQuery,
    page,
    pageQuery,
    pageSearchKey,
    profiles?.rows.length,
    t,
  ]);

  const topCard = useMemo(
    () => (
      <AgentSheetTopCard
        profileCount={profiles === null ? null : profiles.rows.length}
        selectedModelLabel={selectedModelLabel}
        disabled={disabled}
        onOpenProfiles={openProfiles}
        onOpenModel={openModel}
      />
    ),
    [disabled, openModel, openProfiles, profiles, selectedModelLabel],
  );

  let body: ReactNode;
  switch (page.kind) {
    case "home":
      body = (
        <AgentSheetHome
          controls={controls}
          disabled={disabled}
          topCard={topCard}
          footer={pluginItems}
          onOpenSelect={openSelect}
        />
      );
      break;
    case "model":
      body = (
        <MobileModelPageView
          page={modelPage}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          serverId={serverId}
          profiles={profiles?.rows ?? null}
          actions={pickerActions}
        />
      );
      break;
    case "profiles":
      body = (
        <ProfilesPage
          profiles={profiles?.rows ?? NO_PROFILE_ROWS}
          query={pageQuery}
          serverId={serverId}
          actions={pickerActions}
        />
      );
      break;
    case "select":
      body = (
        <AgentSheetSelectPage
          controlId={page.controlId}
          controls={controls}
          query={pageQuery}
          disabled={disabled}
          onPicked={goHome}
        />
      );
      break;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      snapPoints={SNAP_POINTS}
      scrollable={false}
      footer={footer}
      keyboard={keyboard}
      contentStyle={styles.sheetBody}
      contextBridge={contextBridge}
      testID="agent-controls-model-sheet"
    >
      {/* Keyed by page, so each page opens at its top. */}
      <View key={pageKey(page)} style={styles.page}>
        {body}
      </View>
    </AdaptiveModalSheet>
  );
}

/** The Profile and Model rows that head Home; Profile only where the surface offers profiles. */
function AgentSheetTopCard({
  profileCount,
  selectedModelLabel,
  disabled,
  onOpenProfiles,
  onOpenModel,
}: {
  profileCount: number | null;
  selectedModelLabel: string;
  disabled: boolean;
  onOpenProfiles: () => void;
  onOpenModel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      {profileCount !== null ? (
        <SettingsDetailRow
          label={t("modelSelector.profiles")}
          summary={t("modelSelector.profilesSaved", { count: profileCount })}
          onPress={onOpenProfiles}
          disabled={disabled}
          testID="agent-controls-profiles"
        />
      ) : null}
      <SettingsDetailRow
        label={t("modelSelector.model")}
        summary={selectedModelLabel}
        onPress={onOpenModel}
        disabled={disabled}
        accessibilityLabel={t("modelSelector.selectedModel", { model: selectedModelLabel })}
        testID="agent-controls-model"
      />
    </SettingsCard>
  );
}

function pageKey(page: AgentSheetPage): string {
  return page.kind === "select" ? `select:${page.controlId}` : page.kind;
}

function SelectSearchDock({
  controlId,
  controls,
  query,
  searchKey,
  onChangeText,
}: {
  controlId: string;
  controls: AgentSheetControls;
  query: string;
  searchKey: number;
  onChangeText: (query: string) => void;
}) {
  const { t } = useTranslation();
  const item = [...controls.thinkingItems, ...controls.featureItems].find(
    (candidate) => candidate.id === controlId,
  );
  const onSearchQueryChange = item?.type === "select" ? item.onSearchQueryChange : undefined;
  const handleChange = useCallback(
    (next: string) => {
      onChangeText(next);
      onSearchQueryChange?.(next);
    },
    [onChangeText, onSearchQueryChange],
  );
  return (
    <SheetSearchDock
      query={query}
      searchKey={searchKey}
      onChangeText={handleChange}
      placeholder={item ? t("common.actions.search") : t("agentControls.mode.searchPlaceholder")}
      testID="agent-controls-select-search"
    />
  );
}

function ProfilesPage({
  profiles,
  query,
  serverId,
  actions,
}: {
  profiles: readonly AgentProfilePickerRow[];
  query: string;
  serverId: string | null;
  actions: ModelPickerActions;
}) {
  const { t } = useTranslation();
  const view = projectAgentSheetProfiles({
    profiles,
    query,
    canCreate: actions.onEditProfiles !== undefined,
  });
  const profiledLookup = useMemo(() => new Map<string, AgentProfilePickerRow[]>(), []);
  const renderItem = useCallback(
    ({ item }: { item: ModelPickerListItem<AgentProfilePickerRow> }) => (
      <ModelPickerItemRow
        item={item}
        active={false}
        selected={false}
        inSearch={false}
        serverId={serverId}
        profiledLookup={profiledLookup}
        onToggleFold={noop}
        onActivate={noop}
        actions={actions}
      />
    ),
    [actions, profiledLookup, serverId],
  );
  if (view.kind === "empty") {
    return <Text style={styles.empty}>{t("modelSelector.noProfiles")}</Text>;
  }
  if (view.kind === "noMatches") {
    return <ModelSearchNoMatches query={view.query} />;
  }
  return (
    <SheetListCard>
      <SheetFlatList
        data={view.items}
        renderItem={renderItem}
        keyExtractor={getItemKey}
        style={SHEET_LIST_CARD_LIST}
        contentContainerStyle={PROFILES_LIST_CONTENT}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={KEYBOARD_DISMISS_MODE}
        showsVerticalScrollIndicator={false}
        testID="agent-controls-profiles-list"
      />
    </SheetListCard>
  );
}

/** Theme-free: the sheet scrollers drop a themed contentContainerStyle on web (docs/unistyles.md). */
const PROFILES_LIST_CONTENT = { paddingVertical: 4 };

function noop() {}

function getItemKey(item: ModelPickerListItem<AgentProfilePickerRow>): string {
  return item.key;
}

const styles = StyleSheet.create((theme) => ({
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  page: {
    flex: 1,
    minHeight: 0,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
}));
