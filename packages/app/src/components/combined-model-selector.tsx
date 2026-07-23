import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, type ComboboxOption, type ComboboxProps } from "@/components/ui/combobox";
import { ModelBrowser, ModelProviderGlyph, useModelBrowser } from "@/components/model-browser";
import { isNative, isWeb } from "@/constants/platform";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const EMPTY_COMBOBOX_OPTIONS: ComboboxOption[] = [];
const EMPTY_FAVORITE_KEYS = new Set<string>();
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function noop() {}

interface CombinedModelSelectorProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: AgentProvider, modelId: string) => void;
  isLoading: boolean;
  favoriteKeys?: Set<string>;
  onToggleFavorite?: (provider: string, modelId: string) => void;
  renderTrigger?: (input: {
    selectedModelLabel: string;
    onPress: () => void;
    disabled: boolean;
    isOpen: boolean;
    hovered: boolean;
    pressed: boolean;
  }) => React.ReactNode;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  desktopPlacement?: ComboboxProps["desktopPlacement"];
  desktopMinWidth?: number;
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
    glyphSize: number;
    showCaret: boolean;
  };
}

export function CombinedModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  isLoading,
  favoriteKeys = EMPTY_FAVORITE_KEYS,
  onToggleFavorite,
  renderTrigger,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  desktopPlacement,
  desktopMinWidth,
  triggerFill = false,
  toolbar,
}: CombinedModelSelectorProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isContentReady, setIsContentReady] = useState(isWeb);
  const browser = useModelBrowser({
    providers,
    selectedProvider,
    selectedModel,
    isLoading,
    favoriteKeys,
    serverId,
  });
  const { prepareToOpen, reset } = browser;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        prepareToOpen();
        onOpen?.();
        return;
      }
      reset();
      onClose?.();
    },
    [onClose, onOpen, prepareToOpen, reset],
  );

  const handleSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelect],
  );

  useEffect(() => {
    if (isWeb) return () => {};
    if (!isOpen) {
      setIsContentReady(false);
      return () => {};
    }
    const frame = requestAnimationFrame(() => {
      setIsContentReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const handleTriggerPress = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [handleOpenChange, isOpen]);

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

  const selectorBody = isContentReady ? (
    <ModelBrowser
      state={browser}
      onSelect={handleSelect}
      onToggleFavorite={onToggleFavorite}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
    />
  ) : (
    <View style={styles.sheetLoadingState}>
      <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      <Text style={styles.sheetLoadingText}>{t("modelSelector.loadingSelector")}</Text>
    </View>
  );

  return (
    <>
      {renderTrigger ? (
        <Pressable
          ref={anchorRef}
          collapsable={false}
          disabled={disabled}
          onPress={handleTriggerPress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.selectedModel", {
            model: browser.selectedModelLabel,
          })}
          testID="combined-model-selector"
        >
          {({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) =>
            renderTrigger({
              selectedModelLabel: browser.triggerLabel,
              onPress: handleTriggerPress,
              disabled,
              isOpen,
              hovered: Boolean(hovered),
              pressed,
            })
          }
        </Pressable>
      ) : (
        <ComboboxTrigger
          ref={anchorRef}
          collapsable={false}
          disabled={disabled}
          onPress={handleTriggerPress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={t("modelSelector.selectedModel", {
            model: browser.selectedModelLabel,
          })}
          testID="combined-model-selector"
          chevron={toolbar?.showCaret === false ? null : undefined}
        >
          {selectedProvider.trim().length > 0 ? (
            <View style={toolbar?.glyphSize === 20 ? styles.toolbarGlyph20 : styles.toolbarGlyph16}>
              <ModelProviderGlyph
                provider={selectedProvider}
                size={toolbar?.glyphSize ?? ICON_SIZE.md}
              />
            </View>
          ) : null}
          <Text style={styles.triggerText} numberOfLines={1} ellipsizeMode="tail">
            {browser.triggerLabel}
          </Text>
        </ComboboxTrigger>
      )}
      <Combobox
        options={EMPTY_COMBOBOX_OPTIONS}
        value=""
        onSelect={noop}
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement={desktopPlacement}
        desktopMinWidth={desktopMinWidth}
        desktopFixedHeight={browser.desktopFixedHeight}
        header={browser.header}
        mobileChildrenScrollEnabled={!browser.isProviderView || !isNative}
        mobileChildrenContentContainerStyle={styles.mobileBrowserContent}
      >
        {selectorBody}
      </Combobox>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  mobileBrowserContent: {
    paddingHorizontal: 0,
  },
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  toolbarGlyph16: {
    width: 16,
    height: 16,
    flexShrink: 0,
  },
  toolbarGlyph20: {
    width: 20,
    height: 20,
    flexShrink: 0,
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
  sheetLoadingState: {
    minHeight: 160,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sheetLoadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
