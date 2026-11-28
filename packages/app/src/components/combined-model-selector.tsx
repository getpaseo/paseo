import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Keyboard, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfile, AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import type { ComboboxProps } from "@/components/ui/combobox";
import {
  AdaptiveModalSheet,
  type SheetHeader,
  type SheetKeyboard,
} from "@/components/adaptive-modal-sheet";
import { ModelProviderGlyph, useSelectedModelLabels } from "@/components/model-browser";
import { DesktopModelPicker, type ModelPickerActions } from "@/components/model-browser-panes";
import {
  MobileModelPageView,
  SheetSearchDock,
  useMobileModelPage,
} from "@/components/mobile-model-page";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE } from "@/styles/theme";
import {
  TOOLBAR_GLYPH_SIZES,
  toolbarContentSlot,
  type ToolbarGlyph,
} from "@/components/ui/control-geometry";

import { useKeyboardToggle, type KeyboardToggleAction } from "@/hooks/use-keyboard-toggle";

const DEFAULT_TRIGGER_DECORATION = { showCaret: true, tooltip: undefined };
const SHEET_SNAP_POINTS = ["80%", "90%"];
const ESCAPE_KEYS = ["Escape"] as const;

interface CombinedModelSelectorProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => Promise<AgentProfile | null> | void;
  onEditProfile?: (profileId: string) => void;
  renderTrigger?: (input: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
    hovered: boolean;
    pressed: boolean;
  }) => React.ReactNode;
  toggleAction?: KeyboardToggleAction;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  desktopPlacement?: ComboboxProps["desktopPlacement"];
  /**
   * Render the custom trigger as a full-width form field: the outer Pressable
   * becomes a transparent passthrough that stretches its child edge-to-edge and
   * stops painting its own hover/pressed background and rounded corners. The
   * trigger itself owns the field visuals and reads hovered/pressed to show its
   * active state. Without this the trigger stays a content-width toolbar chip
   * (the composer's layout).
   */
  triggerFill?: boolean;
  toolbar?: {
    glyph: ToolbarGlyph;
    showCaret: boolean;
    tooltip?: ReactNode;
  };
}

export function CombinedModelSelector(props: CombinedModelSelectorProps) {
  const isCompact = useIsCompactFormFactor();
  // One frame per form factor: a sheet that drills into providers, or a two-pane popover.
  return isCompact ? (
    <CompactCombinedModelSelector {...props} />
  ) : (
    <DesktopCombinedModelSelector {...props} />
  );
}

function DesktopCombinedModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  renderTrigger,
  toggleAction,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  desktopPlacement,
  triggerFill = false,
  toolbar,
}: CombinedModelSelectorProps) {
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const labels = useSelectedModelLabels({ providers, selectedProvider, selectedModel, isLoading });

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) onOpen?.();
      else onClose?.();
    },
    [onClose, onOpen],
  );
  const handleTriggerPress = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [handleOpenChange, isOpen]);
  const actions = useModelSelectorActions({
    onOpenChange: handleOpenChange,
    onSelect,
    onApplyProfile,
    onEditProfiles,
    onCreateProfile,
    onEditProfile,
  });

  useKeyboardToggle({
    action: toggleAction,
    disabled,
    open: isOpen,
    // The search field holds focus for as long as the popover is open.
    searchFocused: isOpen,
    onToggle: handleTriggerPress,
  });

  return (
    <>
      <ModelSelectorTrigger
        anchorRef={anchorRef}
        isOpen={isOpen}
        disabled={disabled}
        onPress={handleTriggerPress}
        labels={labels}
        selectedProvider={selectedProvider}
        serverId={serverId}
        renderTrigger={renderTrigger}
        triggerFill={triggerFill}
        toolbar={toolbar}
      />
      <DesktopModelPicker
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement={desktopPlacement}
        providers={providers}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        profiles={profiles}
        serverId={serverId}
        onSelect={actions.handleSelect}
        onApplyProfile={actions.handleApplyProfile}
        onEditProfiles={onEditProfiles ? actions.handleEditProfiles : undefined}
        onCreateProfile={onCreateProfile ? actions.handleCreateProfile : undefined}
        onEditProfile={onEditProfile ? actions.handleEditProfile : undefined}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
      />
    </>
  );
}

function CompactCombinedModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  renderTrigger,
  toggleAction,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  triggerFill = false,
  toolbar,
}: CombinedModelSelectorProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const labels = useSelectedModelLabels({ providers, selectedProvider, selectedModel, isLoading });
  const page = useMobileModelPage({ providers, selectedProvider, selectedModel });
  const { reset, clearQuery } = page;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        reset();
        onOpen?.();
        return;
      }
      Keyboard.dismiss();
      onClose?.();
    },
    [onClose, onOpen, reset],
  );
  const handleClose = useCallback(() => handleOpenChange(false), [handleOpenChange]);
  const handleTriggerPress = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [handleOpenChange, isOpen]);

  useKeyboardToggle({
    action: toggleAction,
    disabled,
    open: isOpen,
    searchFocused: false,
    onToggle: handleTriggerPress,
  });

  const actions = useModelSelectorActions({
    onOpenChange: handleOpenChange,
    onSelect,
    onApplyProfile,
    onEditProfiles,
    onCreateProfile,
    onEditProfile,
  });
  const pickerActions = useMemo<ModelPickerActions>(
    () => ({
      onSelect: actions.handleSelect,
      onApplyProfile: actions.handleApplyProfile,
      onEditProfiles: onEditProfiles ? actions.handleEditProfiles : undefined,
      onCreateProfile: onCreateProfile ? actions.handleCreateProfile : undefined,
      onEditProfile: onEditProfile ? actions.handleEditProfile : undefined,
      onRetryProvider,
      isRetryingProvider,
    }),
    [actions, isRetryingProvider, onCreateProfile, onEditProfile, onEditProfiles, onRetryProvider],
  );

  // Escape clears the search first, then closes the sheet.
  const query = page.query;
  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: ESCAPE_KEYS,
      onKeyDown: (event) => {
        if (event.key !== "Escape" || query.trim().length === 0) return false;
        clearQuery();
        return true;
      },
    }),
    [clearQuery, query],
  );
  const header = useMemo<SheetHeader>(() => ({ title: t("modelSelector.selectModel") }), [t]);
  const footer = useMemo(
    () => (
      <SheetSearchDock
        query={page.query}
        searchKey={page.searchKey}
        onChangeText={page.setQuery}
        placeholder={
          providers.length > 1
            ? t("modelSelector.searchAllPlaceholder")
            : t("modelSelector.searchPlaceholder")
        }
        testID="model-search-all-input"
      />
    ),
    [page.query, page.searchKey, page.setQuery, providers.length, t],
  );

  return (
    <>
      <ModelSelectorTrigger
        anchorRef={anchorRef}
        isOpen={isOpen}
        disabled={disabled}
        onPress={handleTriggerPress}
        labels={labels}
        selectedProvider={selectedProvider}
        serverId={serverId}
        renderTrigger={renderTrigger}
        triggerFill={triggerFill}
        toolbar={toolbar}
      />
      <AdaptiveModalSheet
        header={header}
        visible={isOpen}
        onClose={handleClose}
        snapPoints={SHEET_SNAP_POINTS}
        scrollable={false}
        footer={footer}
        keyboard={keyboard}
        contentStyle={styles.sheetBody}
        testID="model-selector-sheet"
      >
        <MobileModelPageView
          page={page}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          serverId={serverId}
          profiles={profiles?.rows ?? null}
          actions={pickerActions}
        />
      </AdaptiveModalSheet>
    </>
  );
}

/**
 * Every pick resolves the selector and closes it. A 1-tap `+` saves the profile, selects its model
 * immediately, and closes the picker; useAgentProfileEditor surfaces a toast with Edit and Undo.
 */
function useModelSelectorActions({
  onOpenChange,
  onSelect,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
}: Pick<
  CombinedModelSelectorProps,
  "onSelect" | "onApplyProfile" | "onEditProfiles" | "onCreateProfile" | "onEditProfile"
> & { onOpenChange: (open: boolean) => void }) {
  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      onOpenChange(false);
    },
    [onOpenChange, onSelect],
  );
  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      onOpenChange(false);
    },
    [onApplyProfile, onOpenChange],
  );
  const handleEditProfiles = useCallback(() => {
    onOpenChange(false);
    onEditProfiles?.();
  }, [onEditProfiles, onOpenChange]);
  const handleCreateProfile = useCallback(
    (seed: AgentProfileSeed) => {
      if (seed.modelId) {
        onSelect(seed.provider, seed.modelId);
      }
      onOpenChange(false);
      void onCreateProfile?.(seed);
    },
    [onCreateProfile, onOpenChange, onSelect],
  );
  const handleEditProfile = useCallback(
    (profileId: string) => {
      onOpenChange(false);
      onEditProfile?.(profileId);
    },
    [onEditProfile, onOpenChange],
  );
  return {
    handleSelect,
    handleApplyProfile,
    handleEditProfiles,
    handleCreateProfile,
    handleEditProfile,
  };
}

function ModelSelectorTrigger({
  anchorRef,
  isOpen,
  disabled,
  onPress,
  labels,
  selectedProvider,
  serverId,
  renderTrigger,
  triggerFill,
  toolbar,
}: {
  anchorRef: RefObject<View | null>;
  isOpen: boolean;
  disabled: boolean;
  onPress: () => void;
  labels: { selectedModelLabel: string; triggerLabel: string };
  selectedProvider: string;
  serverId: string | null;
  renderTrigger: CombinedModelSelectorProps["renderTrigger"];
  triggerFill: boolean;
  toolbar: CombinedModelSelectorProps["toolbar"];
}) {
  const { t } = useTranslation();
  const triggerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (triggerFill) {
        return [
          styles.trigger,
          styles.customTriggerWrapper,
          styles.triggerFill,
          disabled && styles.triggerDisabled,
        ];
      }
      return [
        styles.trigger,
        Boolean(hovered) && styles.triggerHovered,
        (pressed || isOpen) && styles.triggerPressed,
        disabled && styles.triggerDisabled,
        renderTrigger ? styles.customTriggerWrapper : null,
      ];
    },
    [disabled, isOpen, renderTrigger, triggerFill],
  );
  const accessibilityLabel = t("modelSelector.selectedModel", {
    model: labels.selectedModelLabel,
  });
  const { showCaret, tooltip } = toolbar ?? DEFAULT_TRIGGER_DECORATION;

  if (renderTrigger) {
    return (
      <Pressable
        ref={anchorRef}
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID="combined-model-selector"
      >
        {({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) =>
          renderTrigger({
            selectedModelLabel: labels.triggerLabel,
            onPress,
            disabled,
            isOpen,
            hovered: Boolean(hovered),
            pressed,
          })
        }
      </Pressable>
    );
  }
  return (
    <ComboboxTrigger
      ref={anchorRef}
      collapsable={false}
      disabled={disabled}
      onPress={onPress}
      style={triggerStyle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="combined-model-selector"
      chevron={showCaret === false ? null : undefined}
      tooltip={tooltip}
    >
      {selectedProvider.trim().length > 0 ? (
        <View style={toolbar ? styles.toolbarGlyph : styles.glyph}>
          <ModelProviderGlyph
            provider={selectedProvider}
            serverId={serverId}
            size={toolbar?.glyph.size ?? ICON_SIZE.md}
            strokeWidth={toolbar?.glyph.strokeWidth}
            tone={toolbar?.glyph.tone}
          />
        </View>
      ) : null}
      <Text style={styles.triggerText} numberOfLines={1} ellipsizeMode="tail">
        {labels.triggerLabel}
      </Text>
    </ComboboxTrigger>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  trigger: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    ...toolbarContentSlot(),
    borderRadius: theme.borderRadius.full,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  glyph: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    flexShrink: 0,
  },
  toolbarGlyph: {
    width: TOOLBAR_GLYPH_SIZES.label,
    height: TOOLBAR_GLYPH_SIZES.label,
    flexShrink: 0,
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
  // A custom trigger, such as a form field, owns its own box: none of the toolbar slot applies.
  customTriggerWrapper: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    height: "auto",
  },
  triggerFill: {
    alignSelf: "stretch",
    flexShrink: 0,
    flexDirection: "column",
    alignItems: "stretch",
    backgroundColor: "transparent",
    borderRadius: 0,
  },
}));
