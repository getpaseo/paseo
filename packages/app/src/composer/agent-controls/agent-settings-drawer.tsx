import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfile, AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import {
  AdaptiveModalSheet,
  type SheetHeader,
  type SheetKeyboard,
} from "@/components/adaptive-modal-sheet";
import { ModelProviderGlyph } from "@/components/model-browser";
import type { ModelPickerActions } from "@/components/model-browser-panes";
import {
  MobileModelPageView,
  SheetSearchDock,
  useMobileModelPage,
} from "@/components/mobile-model-page";
import { SettingsCard, SettingsDetailRow } from "@/components/settings";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import type { KeyboardInputEvent } from "@/keyboard";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE } from "@/styles/theme";
import { AGENT_SHEET_HOME, resolveAgentSheetEscape, type AgentSheetPage } from "./model-sheet-flow";
import {
  AgentSheetHome,
  AgentSheetSelectPage,
  selectPageIsSearchable,
  selectPageTitle,
  type AgentSheetControls,
} from "./sheet-home";

const SNAP_POINTS = ["80%", "90%"];
const ESCAPE_KEYS = ["Escape"] as const;

/** The drawer's Model row and page. */
export interface AgentSettingsDrawerModel {
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  selectedModelLabel: string;
  canSwitchProvider: boolean;
  serverId: string | null;
  profiles: AgentProfilePicker | null;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}

export interface AgentSettingsDrawerProps {
  visible: boolean;
  onClose: () => void;
  contextBridge: ContextBridge | null;
  disabled: boolean;
  controls: AgentSheetControls;
  /** Drawn below the controls on Home. */
  pluginItems: ReactNode;
  /** Null when the host hides the model picker: Home has no Model row. */
  model: AgentSettingsDrawerModel | null;
}

const NO_PROVIDERS: readonly ProviderSelectorProvider[] = [];

/**
 * The compact agent settings: one drawer whose page changes in place. Home lays out every control;
 * Model (which also holds Profiles) and a long select each take the drawer over with a way back
 * to Home.
 */
export function AgentSettingsDrawer({
  visible,
  onClose,
  contextBridge,
  disabled,
  controls,
  pluginItems,
  model,
}: AgentSettingsDrawerProps) {
  const providers = model?.providers ?? NO_PROVIDERS;
  const selectedProvider = model?.selectedProvider ?? "";
  const selectedModel = model?.selectedModel ?? "";
  const selectedModelLabel = model?.selectedModelLabel ?? "";
  const canSwitchProvider = model?.canSwitchProvider ?? false;
  const serverId = model?.serverId ?? null;
  const profiles = model?.profiles ?? null;
  const onSelect = model?.onSelect;
  const onApplyProfile = model?.onApplyProfile;
  const onEditProfiles = model?.onEditProfiles;
  const onCreateProfile = model?.onCreateProfile;
  const onEditProfile = model?.onEditProfile;
  const onRetryProvider = model?.onRetryProvider;
  const isRetryingProvider = model?.isRetryingProvider ?? false;
  const { t } = useTranslation();
  const [page, setPage] = useState<AgentSheetPage>(AGENT_SHEET_HOME);
  // Select pages search with this; the Model page keeps its own.
  const [pageQuery, setPageQuery] = useState("");
  const [pageSearchKey, setPageSearchKey] = useState(0);
  const modelPage = useMobileModelPage({
    providers,
    profiles: profiles?.rows ?? null,
    canCreateProfile: Boolean(onEditProfiles),
    selectedProvider,
    selectedModel,
  });

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
      onSelect?.(provider, modelId);
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
      if (seed.modelId) onSelect?.(seed.provider, seed.modelId);
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
      case "select":
        return {
          title: selectPageTitle(page.controlId, controls, t("agentControls.mode.title")),
          back,
        };
    }
  }, [controls, goHome, page, t]);

  const footer = useMemo(() => {
    switch (page.kind) {
      case "home":
        return null;
      case "model": {
        let placeholder = t("modelSelector.searchPlaceholder");
        if (profiles && profiles.rows.length > 0) {
          placeholder = t("modelSelector.searchModelsAndProfilesPlaceholder");
        } else if (canSwitchProvider) {
          placeholder = t("modelSelector.searchAllPlaceholder");
        }
        return (
          <SheetSearchDock
            query={modelPage.query}
            searchKey={modelPage.searchKey}
            onChangeText={modelPage.setQuery}
            placeholder={placeholder}
            testID="model-search-all-input"
          />
        );
      }
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
    profiles,
    t,
  ]);

  const hasModel = model !== null;
  const topCard = useMemo(
    () =>
      hasModel ? (
        <AgentSheetTopCard
          selectedProvider={selectedProvider}
          serverId={serverId}
          selectedModelLabel={selectedModelLabel}
          disabled={disabled}
          onOpenModel={openModel}
        />
      ) : null,
    [disabled, hasModel, openModel, selectedModelLabel, selectedProvider, serverId],
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

/** The Model row that heads Home. */
function AgentSheetTopCard({
  selectedProvider,
  serverId,
  selectedModelLabel,
  disabled,
  onOpenModel,
}: {
  selectedProvider: string;
  serverId: string | null;
  selectedModelLabel: string;
  disabled: boolean;
  onOpenModel: () => void;
}) {
  const { t } = useTranslation();
  const hasProvider = selectedProvider.trim().length > 0;
  const summaryLeading = useMemo(
    () =>
      hasProvider ? (
        <ModelProviderGlyph provider={selectedProvider} serverId={serverId} size={ICON_SIZE.sm} />
      ) : undefined,
    [hasProvider, selectedProvider, serverId],
  );
  return (
    <SettingsCard>
      <SettingsDetailRow
        label={t("modelSelector.model")}
        summary={selectedModelLabel}
        summaryLeading={summaryLeading}
        onPress={onOpenModel}
        disabled={disabled}
        accessibilityLabel={t("modelSelector.selectedModel", {
          model: selectedModelLabel,
        })}
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

const styles = StyleSheet.create(() => ({
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
}));
