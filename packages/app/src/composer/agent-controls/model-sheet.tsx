import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfile, AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { TailEllipsisText } from "@/components/ui/tail-ellipsis-text";
import { useProviderIcon } from "@/components/provider-icons";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { resolveModelTriggerLabels } from "@/composer/agent-controls/layout";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import {
  toolbarContentSlot,
  toolbarSlot,
  type ToolbarGlyphs,
} from "@/components/ui/control-geometry";
import { getAgentControlHintKey, shortModelLabel } from "./utils";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardToggle } from "@/hooks/use-keyboard-toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerControls, ControlTooltipHint } from "./composer-control";
import { useModelPickerShortcut } from "./control-items";
import { AgentSettingsDrawer } from "./agent-settings-drawer";
import { AgentModeControl } from "./mode-control";
import type { AgentSheetControls } from "./sheet-home";

const SNAP_POINTS = ["80%", "90%"];
// The dialog's model list scrolls inside its fixed viewport, apart from the controls below it.
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
  effortKeys: ReturnType<typeof useShortcutKeys>;
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  glyphs: ToolbarGlyphs;
  /** False when the toolbar is too narrow for labels: the trigger shows the provider glyph only. */
  showLabels: boolean;
  canSwitchProvider: boolean;
  /** Carries the composer's contexts into the sheets, which draw away from it. */
  contextBridge?: ContextBridge | null;
  controls: AgentSheetControls;
  /** Plugin controls, drawn after the agent's own. */
  pluginItems: ReactNode;
  /** The control whose list is open, in the narrow-pane dialog. */
  openControlId: string | null;
  onOpenControlIdChange: (id: string | null) => void;
}

function resolveModelSheetProfileActions(
  onCreateProfile: ((seed: AgentProfileSeed) => Promise<AgentProfile | null> | void) | undefined,
  onEditProfile: ((profileId: string) => void) | undefined,
  onSelect: (provider: string, modelId: string) => void,
  close: () => void,
): {
  create?: (seed: AgentProfileSeed) => void;
  edit?: (profileId: string) => void;
} {
  return {
    create: onCreateProfile
      ? (seed: AgentProfileSeed) => {
          if (seed.modelId) {
            onSelect(seed.provider, seed.modelId);
          }
          close();
          void onCreateProfile(seed);
        }
      : undefined,
    edit: onEditProfile
      ? (profileId: string) => {
          close();
          onEditProfile(profileId);
        }
      : undefined,
  };
}

/**
 * Measures the folded model control and decides which labels it shows; see
 * `resolveModelTriggerLabels`. The full width is keyed by what was measured, so a new label is
 * `measuring` until its own width is known instead of reusing the previous label's.
 */
function useModelTriggerLabels(input: {
  modelLabel: string;
  thinkingLabel: string | null;
  glyphSize: number;
}) {
  const { modelLabel, thinkingLabel, glyphSize } = input;
  const measuredKey = `${glyphSize}\n${modelLabel}\n${thinkingLabel ?? ""}`;
  const [availableWidth, setAvailableWidth] = useState<number | undefined>(undefined);
  const [fullWidth, setFullWidth] = useState<{
    key: string;
    width: number;
  } | null>(null);

  const onFrameLayout = useCallback((event: LayoutChangeEvent) => {
    const width = readMeasuredWidth(event);
    if (width !== null) setAvailableWidth(width);
  }, []);
  const onFullLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = readMeasuredWidth(event);
      if (width !== null) setFullWidth({ key: measuredKey, width });
    },
    [measuredKey],
  );

  const labels = resolveModelTriggerLabels({
    hasThinking: thinkingLabel !== null,
    measurements: {
      availableWidth,
      fullWidth: fullWidth?.key === measuredKey ? fullWidth.width : undefined,
    },
  });
  return { labels, measuredKey, onFrameLayout, onFullLayout };
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  thinkingLabel,
  effortKeys,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  glyphs,
  showLabels,
  canSwitchProvider,
  contextBridge = null,
  controls,
  pluginItems,
  openControlId,
  onOpenControlIdChange,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const [isOpen, setIsOpen] = useState(false);
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
  const ModelIcon = useProviderIcon(selectedProvider, serverId);
  const hasSelectedProvider = selectedProvider.trim().length > 0;

  const open = useCallback(() => {
    Keyboard.dismiss();
    rootBrowser.showAll();
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, rootBrowser]);

  const close = useCallback(() => {
    setIsOpen(false);
    rootBrowser.reset();
    onClose?.();
  }, [onClose, rootBrowser]);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  return (
    <>
      <ModelSheetTrigger
        ModelIcon={hasSelectedProvider ? ModelIcon : null}
        modelLabel={shortModelLabel(rootBrowser.triggerLabel)}
        thinkingLabel={thinkingLabel}
        glyphs={glyphs}
        iconOnly={!showLabels && hasSelectedProvider}
        isOpen={isOpen}
        searchFocused={rootBrowser.isSearchFocused}
        disabled={disabled}
        onPress={toggle}
        accessibilityLabel={t("modelSelector.selectedModel", {
          model: rootBrowser.selectedModelLabel,
        })}
        effortKeys={effortKeys}
      />

      {usesBottomSheet ? (
        <AgentSettingsDrawer
          visible={isOpen}
          onClose={close}
          contextBridge={contextBridge}
          disabled={disabled}
          controls={controls}
          pluginItems={pluginItems}
          model={{
            providers: availableProviders,
            selectedProvider,
            selectedModel,
            selectedModelLabel: rootBrowser.selectedModelLabel,
            canSwitchProvider,
            serverId,
            profiles,
            onSelect,
            onApplyProfile,
            onEditProfiles,
            onCreateProfile,
            onEditProfile,
            onRetryProvider,
            isRetryingProvider,
          }}
        />
      ) : (
        <NarrowPaneModelDialog
          visible={isOpen}
          onClose={close}
          contextBridge={contextBridge}
          browser={rootBrowser}
          canSwitchProvider={canSwitchProvider}
          disabled={disabled}
          controls={controls}
          pluginItems={pluginItems}
          openControlId={openControlId}
          onOpenControlIdChange={onOpenControlIdChange}
          onSelect={onSelect}
          onApplyProfile={onApplyProfile}
          onEditProfiles={onEditProfiles}
          onCreateProfile={onCreateProfile}
          onEditProfile={onEditProfile}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      )}
    </>
  );
}

/**
 * A narrow composer pane in a wide window: the model browser above the agent's controls, in one
 * dialog.
 */
function NarrowPaneModelDialog({
  visible,
  onClose,
  contextBridge,
  browser,
  canSwitchProvider,
  disabled,
  controls,
  pluginItems,
  openControlId,
  onOpenControlIdChange,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onRetryProvider,
  isRetryingProvider,
}: {
  visible: boolean;
  onClose: () => void;
  contextBridge: ContextBridge | null;
  browser: ReturnType<typeof useModelBrowser>;
  canSwitchProvider: boolean;
  disabled: boolean;
  controls: AgentSheetControls;
  pluginItems: ReactNode;
  openControlId: string | null;
  onOpenControlIdChange: (id: string | null) => void;
  onSelect: (provider: string, modelId: string) => void;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({
      ...browser.header,
      title: t("modelSelector.selectModel"),
      search:
        browser.header.search && !canSwitchProvider
          ? {
              ...browser.header.search,
              placeholder: t("modelSelector.searchPlaceholder"),
            }
          : browser.header.search,
    }),
    [canSwitchProvider, browser.header, t],
  );
  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      onClose();
    },
    [onClose, onSelect],
  );
  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      onClose();
    },
    [onClose, onApplyProfile],
  );
  const handleEditProfiles = useCallback(() => {
    onClose();
    onEditProfiles?.();
  }, [onClose, onEditProfiles]);
  const profileActions = resolveModelSheetProfileActions(
    onCreateProfile,
    onEditProfile,
    onSelect,
    onClose,
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      scrollable={false}
      keyboard={browser.keyboard}
      contentStyle={styles.sheetBody}
      contextBridge={contextBridge}
      testID="agent-controls-model-sheet"
    >
      <View
        style={[styles.modelViewport, styles.fixedModelViewport]}
        testID="agent-controls-model-viewport"
      >
        <ModelBrowser
          state={browser}
          onSelect={handleSelect}
          onApplyProfile={handleApplyProfile}
          onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
          onCreateProfile={profileActions.create}
          onEditProfile={profileActions.edit}
          onRetryProvider={onRetryProvider}
          isRetryingProvider={isRetryingProvider}
        />
      </View>
      <View style={styles.modelViewportDivider} />
      <ScrollView
        style={styles.controlsScroll}
        contentContainerStyle={styles.controlsContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        testID="agent-controls-settings-list"
      >
        <View style={styles.combinedControls} testID="agent-controls-combined-sheet-controls">
          <ComposerControls
            items={controls.thinkingItems}
            surface="sheet"
            disabled={disabled}
            openId={openControlId}
            onOpenIdChange={onOpenControlIdChange}
          />
          {controls.modeControl ? (
            <AgentModeControl {...controls.modeControl} surface="sheet" />
          ) : null}
          <ComposerControls
            items={controls.featureItems}
            surface="sheet"
            disabled={disabled}
            openId={openControlId}
            onOpenIdChange={onOpenControlIdChange}
          />
          {pluginItems}
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

/**
 * The folded model control in the toolbar: the provider glyph, then the model and thinking
 * labels for as long as they fit.
 */
interface ModelSheetTriggerProps {
  /** The selected provider's glyph, or null before a provider is selected. */
  ModelIcon: ReturnType<typeof useProviderIcon> | null;
  modelLabel: string;
  thinkingLabel: string | null;
  glyphs: ToolbarGlyphs;
  iconOnly: boolean;
  isOpen: boolean;
  searchFocused: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  effortKeys: ReturnType<typeof useShortcutKeys>;
}

function ModelSheetTrigger({
  ModelIcon,
  modelLabel,
  thinkingLabel,
  glyphs,
  iconOnly,
  isOpen,
  searchFocused,
  disabled,
  onPress,
  accessibilityLabel,
  effortKeys,
}: ModelSheetTriggerProps) {
  const { t } = useTranslation();
  const { action: toggleAction, keys: modelKeys } = useModelPickerShortcut(disabled);
  useKeyboardToggle({
    action: toggleAction,
    disabled,
    open: isOpen,
    searchFocused,
    onToggle: onPress,
  });

  const glyphRole = iconOnly ? "icon" : "label";
  const glyph = glyphs[glyphRole];
  const triggerLabels = useModelTriggerLabels({
    modelLabel,
    thinkingLabel: iconOnly ? null : thinkingLabel,
    glyphSize: glyph.size,
  });
  const providerIconColor =
    glyph.tone === "foreground" ? styles.providerIconForeground.color : styles.providerIcon.color;
  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.trigger,
      iconOnly && styles.triggerIconOnly,
      hovered && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, iconOnly, isOpen],
  );

  const trigger = (
    <View style={styles.triggerFrame} onLayout={triggerLabels.onFrameLayout}>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID="combined-model-selector"
        chevron={null}
      >
        {ModelIcon ? (
          <ComposerToolbarGlyph role={glyphRole}>
            <ModelIcon
              size={glyph.size}
              strokeWidth={glyph.strokeWidth}
              color={providerIconColor}
            />
          </ComposerToolbarGlyph>
        ) : null}
        {!iconOnly ? (
          <View
            style={[
              styles.triggerLabels,
              triggerLabels.labels === "measuring" && styles.triggerLabelsMeasuring,
            ]}
          >
            <TailEllipsisText
              text={modelLabel}
              style={styles.triggerText}
              testID="combined-model-selector-model-label"
            />
            {thinkingLabel && triggerLabels.labels !== "model" ? (
              <Text
                style={styles.triggerThinking}
                numberOfLines={1}
                testID="combined-model-selector-thinking-label"
              >
                {thinkingLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ComboboxTrigger>
      {!iconOnly && thinkingLabel ? (
        <View
          // Keyed by what it measures: a retained node whose size does not change emits no new
          // layout event, so new labels would never be measured.
          key={triggerLabels.measuredKey}
          style={[styles.trigger, styles.triggerMeasurer]}
          onLayout={triggerLabels.onFullLayout}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
        >
          {ModelIcon ? <ComposerToolbarGlyph role={glyphRole}>{null}</ComposerToolbarGlyph> : null}
          <View style={styles.triggerLabels}>
            <Text style={[styles.triggerText, styles.triggerMeasuredText]} numberOfLines={1}>
              {modelLabel}
            </Text>
            <Text style={styles.triggerThinking} numberOfLines={1}>
              {thinkingLabel}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        {trigger}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <ControlTooltipHint label={t(getAgentControlHintKey("model"))} shortcutKeys={modelKeys} />
        {effortKeys ? (
          <ControlTooltipHint
            label={t("settings.shortcuts.help.cycleEffort")}
            shortcutKeys={effortKeys}
          />
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    ...toolbarContentSlot(),
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
  },
  triggerIconOnly: {
    ...toolbarSlot(),
    flexShrink: 0,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerLabels: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  triggerLabelsMeasuring: {
    opacity: 0,
  },
  /** The space the trigger may take; the trigger itself stays as wide as its content. */
  triggerFrame: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  /** An invisible copy of the trigger with both labels untruncated. */
  triggerMeasurer: {
    position: "absolute",
    left: 0,
    top: 0,
    flexShrink: 0,
    opacity: 0,
  },
  triggerMeasuredText: {
    flexShrink: 0,
  },
  triggerThinking: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
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
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  combinedControls: {
    gap: theme.spacing[1],
  },
}));
