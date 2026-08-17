import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { getProviderIcon } from "@/components/provider-icons";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import {
  resolveModelBrowserScrolling,
  resolveModelSheetOpening,
} from "@/composer/agent-controls/model-sheet-flow";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

const SNAP_POINTS = ["80%", "90%"];
const MODEL_LIST_TOP_INSET = 4;
const MODEL_ROW_STRIDE = 44;
const MODEL_VIEWPORT_VISIBLE_ROWS = 4.5;
const FIXED_MODEL_VIEWPORT_HEIGHT =
  MODEL_LIST_TOP_INSET + MODEL_ROW_STRIDE * MODEL_VIEWPORT_VISIBLE_ROWS;

interface CompactModelSheetProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  thinkingLabel: string | null;
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  glyphSize: number;
  canSwitchProvider: boolean;
  children: ReactNode;
}

function shortModelLabel(label: string): string {
  const separatorIndex = label.lastIndexOf("/");
  return separatorIndex === -1 ? label : label.slice(separatorIndex + 1);
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  thinkingLabel,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  glyphSize,
  canSwitchProvider,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const modelBrowserScrolling = resolveModelBrowserScrolling(usesBottomSheet);
  const [isOpen, setIsOpen] = useState(false);
  const [isModelBrowserOpen, setIsModelBrowserOpen] = useState(false);
  const availableProviders = useMemo(() => {
    if (canSwitchProvider) return providers;
    const fixedProvider =
      providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
    return fixedProvider ? [fixedProvider] : [];
  }, [canSwitchProvider, providers, selectedProvider]);
  const rootBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch: isWeb && !usesBottomSheet,
    profiles,
    serverId,
  });
  const modelBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch: isWeb && !usesBottomSheet,
    serverId,
  });
  const ProviderIcon =
    selectedProvider.trim().length > 0 ? getProviderIcon(selectedProvider) : null;
  const ModelIcon = ProviderIcon ?? Bot;
  const rootHeader = useMemo(
    () => ({
      ...rootBrowser.header,
      title: t("modelSelector.selectModel"),
      search:
        rootBrowser.header.search && !canSwitchProvider
          ? {
              ...rootBrowser.header.search,
              placeholder: t("modelSelector.searchPlaceholder"),
            }
          : rootBrowser.header.search,
    }),
    [canSwitchProvider, rootBrowser.header, t],
  );

  const open = useCallback(() => {
    Keyboard.dismiss();
    rootBrowser.showAll();
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, rootBrowser]);

  const close = useCallback(() => {
    setIsModelBrowserOpen(false);
    setIsOpen(false);
    rootBrowser.reset();
    modelBrowser.reset();
    onClose?.();
  }, [modelBrowser, onClose, rootBrowser]);

  const handleSearchSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      Keyboard.dismiss();
      rootBrowser.showAll();
    },
    [onSelect, rootBrowser],
  );

  const openModelBrowser = useCallback(() => {
    Keyboard.dismiss();
    const destination = resolveModelSheetOpening({
      canSwitchProvider,
      providers: availableProviders,
      selectedProvider,
    });
    if (destination.kind === "all") {
      modelBrowser.showAll();
    } else {
      modelBrowser.drillDown(destination.providerId, destination.providerLabel);
    }
    setIsModelBrowserOpen(true);
  }, [availableProviders, canSwitchProvider, modelBrowser, selectedProvider]);

  const closeModelBrowser = useCallback(() => {
    setIsModelBrowserOpen(false);
    modelBrowser.reset();
  }, [modelBrowser]);

  const handleBrowserSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      closeModelBrowser();
    },
    [closeModelBrowser, onSelect],
  );

  const handleDesktopSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      close();
    },
    [close, onSelect],
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

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, isOpen],
  );
  const mobileRootContent = useMemo(
    () => (
      <View style={styles.mobileRootContent} testID="agent-controls-settings-list">
        <View style={styles.controlsContent}>
          <AgentControlTrigger
            icon={ModelIcon}
            surface="sheet"
            label={t("modelSelector.model")}
            value={rootBrowser.selectedModelLabel}
            disabled={disabled}
            onPress={openModelBrowser}
            accessibilityLabel={t("modelSelector.selectedModel", {
              model: rootBrowser.selectedModelLabel,
            })}
            testID="agent-controls-model"
          />
          {children}
        </View>
      </View>
    ),
    [ModelIcon, children, disabled, openModelBrowser, rootBrowser.selectedModelLabel, t],
  );

  return (
    <>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={toggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("modelSelector.selectedModel", {
          model: rootBrowser.selectedModelLabel,
        })}
        testID="combined-model-selector"
        chevron={null}
      >
        {ProviderIcon ? (
          <ComposerToolbarGlyph size={glyphSize}>
            <ProviderIcon size={glyphSize} color={styles.providerIcon.color} />
          </ComposerToolbarGlyph>
        ) : null}
        <View style={styles.triggerLabels}>
          <Text style={styles.triggerText} numberOfLines={1}>
            {shortModelLabel(rootBrowser.triggerLabel)}
          </Text>
          {thinkingLabel ? (
            <Text style={styles.triggerThinking} numberOfLines={1}>
              {thinkingLabel}
            </Text>
          ) : null}
        </View>
      </ComboboxTrigger>

      <AdaptiveModalSheet
        header={rootHeader}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        sizeContentToCurrentSnapPoint={usesBottomSheet}
        contentStyle={styles.sheetBody}
        testID="agent-controls-model-sheet"
      >
        <View
          style={[
            styles.modelViewport,
            usesBottomSheet ? styles.flexibleModelViewport : styles.fixedModelViewport,
          ]}
          testID="agent-controls-model-viewport"
        >
          <ModelBrowser
            state={rootBrowser}
            onSelect={usesBottomSheet ? handleSearchSelect : handleDesktopSelect}
            onApplyProfile={handleApplyProfile}
            onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
            scrolling={modelBrowserScrolling}
            searchAllOnFocus={usesBottomSheet}
            rootBrowseContent={usesBottomSheet ? mobileRootContent : undefined}
          />
        </View>
        {!usesBottomSheet ? (
          <>
            <View style={styles.modelViewportDivider} />
            <ScrollView
              style={styles.controlsScroll}
              contentContainerStyle={styles.controlsContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              testID="agent-controls-settings-list"
            >
              {children}
            </ScrollView>
          </>
        ) : null}
      </AdaptiveModalSheet>

      {usesBottomSheet ? (
        <AdaptiveModalSheet
          header={modelBrowser.header}
          visible={isModelBrowserOpen}
          onClose={closeModelBrowser}
          snapPoints={SNAP_POINTS}
          scrollable={false}
          sizeContentToCurrentSnapPoint
          presentation="push"
          contentStyle={styles.sheetBody}
          testID="agent-controls-model-browser-sheet"
        >
          <View
            style={[styles.modelViewport, styles.flexibleModelViewport]}
            testID="agent-controls-model-browser-viewport"
          >
            <ModelBrowser
              state={modelBrowser}
              onSelect={handleBrowserSelect}
              onRetryProvider={onRetryProvider}
              isRetryingProvider={isRetryingProvider}
              scrolling={modelBrowserScrolling}
              searchAllOnFocus
            />
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  triggerLabels: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  triggerThinking: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  modelViewport: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  flexibleModelViewport: {
    flex: 1,
    minHeight: 0,
  },
  fixedModelViewport: {
    height: FIXED_MODEL_VIEWPORT_HEIGHT,
    minHeight: FIXED_MODEL_VIEWPORT_HEIGHT,
  },
  modelViewportDivider: {
    height: 1,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
  },
  controlsScroll: {
    flex: 1,
    minHeight: 0,
  },
  mobileRootContent: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
