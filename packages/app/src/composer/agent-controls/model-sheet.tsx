import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { getProviderIcon } from "@/components/provider-icons";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";

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
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  favoriteKeys: Set<string>;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  glyphSize: number;
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
  onSelect,
  isLoading,
  favoriteKeys,
  onToggleFavorite,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  glyphSize,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const [isOpen, setIsOpen] = useState(false);
  const browser = useModelBrowser({
    providers,
    selectedProvider,
    selectedModel,
    isLoading,
    favoriteKeys,
    serverId,
  });
  const { prepareToOpen, reset } = browser;
  const ProviderIcon =
    selectedProvider.trim().length > 0 ? getProviderIcon(selectedProvider) : null;
  const compactFooter = useMemo(
    () =>
      usesBottomSheet ? (
        <View style={styles.compactFooter} testID="agent-controls-settings-list">
          <View style={styles.modelViewportDivider} />
          <View style={[styles.controlsContent, styles.compactControlsContent]}>{children}</View>
        </View>
      ) : undefined,
    [children, usesBottomSheet],
  );

  const open = useCallback(() => {
    Keyboard.dismiss();
    prepareToOpen();
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, prepareToOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    reset();
    onClose?.();
  }, [onClose, reset]);

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      close();
    },
    [close, onSelect],
  );

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

  return (
    <>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={toggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("modelSelector.selectedModel", {
          model: browser.selectedModelLabel,
        })}
        testID="combined-model-selector"
        chevron={null}
      >
        {ProviderIcon ? (
          <ComposerToolbarGlyph size={glyphSize}>
            <ProviderIcon size={glyphSize} color={styles.providerIcon.color} />
          </ComposerToolbarGlyph>
        ) : null}
        <Text style={styles.triggerText} numberOfLines={1}>
          {shortModelLabel(browser.triggerLabel)}
        </Text>
      </ComboboxTrigger>

      <AdaptiveModalSheet
        header={browser.header}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        sizeContentToCurrentSnapPoint={usesBottomSheet}
        footer={compactFooter}
        footerContainerStyle={usesBottomSheet ? styles.compactFooterContainer : undefined}
        contentContainerStyle={styles.sheetBody}
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
            state={browser}
            onSelect={handleSelect}
            onToggleFavorite={onToggleFavorite}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
            scrolling="independent"
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
  compactFooterContainer: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 0,
    paddingHorizontal: 0,
    paddingTop: 0,
    borderTopWidth: 0,
  },
  compactFooter: {
    minWidth: 0,
  },
  compactControlsContent: {
    paddingBottom: 0,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
