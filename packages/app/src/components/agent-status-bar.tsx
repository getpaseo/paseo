import { memo, useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, Keyboard } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  Brain,
  ChevronDown,
  ListTodo,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Zap,
} from "lucide-react-native";
import { getProviderIcon } from "@/components/provider-icons";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import {
  buildFavoriteModelKey,
  mergeProviderPreferences,
  toggleFavoriteModel,
  useFormPreferences,
} from "@/hooks/use-form-preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import {
  getModeVisuals,
  type AgentModeColorTier,
  type AgentModeIcon,
} from "@server/server/agent/provider-manifest";
import {
  getFeatureHighlightColor,
  getFeatureTooltip,
  getStatusSelectorHint,
  resolveAgentModelSelection,
} from "@/components/agent-status-bar.utils";
import { isWeb as platformIsWeb } from "@/constants/platform";

type StatusOption = {
  id: string;
  label: string;
};

type StatusSelector = "provider" | "mode" | "model" | "thinking" | `feature-${string}`;

type ControlledAgentStatusBarProps = {
  provider: string;
  providerOptions?: StatusOption[];
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  modeOptions?: StatusOption[];
  selectedModeId?: string;
  onSelectMode?: (modeId: string) => void;
  modelOptions?: StatusOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  thinkingOptions?: StatusOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  providerDefinitions: AgentProviderDefinition[];
  allProviderModels?: Map<string, AgentModelDefinition[]>;
  canSelectModelProvider?: (providerId: string) => boolean;
  favoriteKeys?: Set<string>;
  onToggleFavoriteModel?: (provider: string, modelId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
};

export interface DraftAgentStatusBarProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  onSelectProvider: (provider: AgentProvider) => void;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  allProviderModels: Map<string, AgentModelDefinition[]>;
  isAllModelsLoading: boolean;
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  disabled?: boolean;
}

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
  onDropdownClose?: () => void;
}

function findOptionLabel(
  options: StatusOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

const FEATURE_ICONS: Record<string, typeof Zap> = {
  "list-todo": ListTodo,
  zap: Zap,
};

function getFeatureIcon(icon?: string) {
  return (icon && FEATURE_ICONS[icon]) || Settings2;
}

function getFeatureIconColor(
  featureId: string,
  enabled: boolean,
  palette: {
    blue: { 400: string };
    yellow: { 400: string };
  },
  foregroundMuted: string,
): string {
  if (!enabled) {
    return foregroundMuted;
  }

  switch (getFeatureHighlightColor(featureId)) {
    case "blue":
      return palette.blue[400];
    case "yellow":
      return palette.yellow[400];
    default:
      return foregroundMuted;
  }
}

const MODE_ICONS = {
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
} as const;

function getModeIconColor(
  colorTier: AgentModeColorTier | undefined,
  palette: {
    blue: { 500: string };
    green: { 500: string };
    red: { 500: string };
    purple: { 500: string };
  },
): string {
  switch (colorTier) {
    case "safe":
      return palette.green[500];
    case "moderate":
      return palette.blue[500];
    case "dangerous":
      return palette.red[500];
    case "planning":
      return palette.purple[500];
    default:
      return palette.blue[500];
  }
}

function ControlledStatusBar({
  provider,
  providerOptions,
  selectedProviderId,
  onSelectProvider,
  modeOptions,
  selectedModeId,
  onSelectMode,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
  providerDefinitions,
  allProviderModels,
  canSelectModelProvider,
  favoriteKeys = new Set<string>(),
  onToggleFavoriteModel,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
}: ControlledAgentStatusBarProps) {
  const { theme } = useUnistyles();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [openSelector, setOpenSelector] = useState<StatusSelector | null>(null);

  const providerAnchorRef = useRef<View>(null);
  const modeAnchorRef = useRef<View>(null);
  const modelAnchorRef = useRef<View>(null);
  const thinkingAnchorRef = useRef<View>(null);

  const canSelectProvider = Boolean(
    onSelectProvider && providerOptions && providerOptions.length > 0,
  );
  const canSelectMode = Boolean(onSelectMode && modeOptions && modeOptions.length > 0);
  const canSelectModel = Boolean(onSelectModel);
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 0,
  );

  const displayProvider = findOptionLabel(providerOptions, selectedProviderId, "Provider");
  const displayMode = findOptionLabel(modeOptions, selectedModeId, "Default");
  const displayModel =
    isModelLoading && (!modelOptions || modelOptions.length === 0)
      ? "Loading models..."
      : findOptionLabel(modelOptions, selectedModelId, "Select model");
  const displayThinking = findOptionLabel(
    thinkingOptions,
    selectedThinkingOptionId,
    thinkingOptions?.[0]?.label ?? "Unknown",
  );

  const modeVisuals = selectedModeId
    ? getModeVisuals(provider, selectedModeId, providerDefinitions)
    : undefined;
  const ModeIconComponent = modeVisuals?.icon ? MODE_ICONS[modeVisuals.icon] : null;
  const modeIconColor = getModeIconColor(modeVisuals?.colorTier, theme.colors.palette);
  const ProviderIcon = getProviderIcon(provider);

  const hasAnyControl =
    Boolean(providerOptions?.length) ||
    Boolean(modeOptions?.length) ||
    canSelectModel ||
    Boolean(thinkingOptions?.length) ||
    Boolean(features?.length);

  if (!hasAnyControl) {
    return null;
  }

  const modelDisabled = disabled;

  const SEARCH_THRESHOLD = 6;

  const comboboxProviderOptions = useMemo<ComboboxOption[]>(
    () => (providerOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [providerOptions],
  );
  const comboboxModeOptions = useMemo<ComboboxOption[]>(
    () => (modeOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [modeOptions],
  );
  const comboboxModelOptions = useMemo<ComboboxOption[]>(
    () => (modelOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [modelOptions],
  );
  const fallbackAllProviderModels = useMemo(() => {
    const map = new Map<string, AgentModelDefinition[]>();
    if (!modelOptions || modelOptions.length === 0) {
      return map;
    }

    map.set(
      provider,
      modelOptions.map((option) => ({
        provider: provider as AgentProvider,
        id: option.id,
        label: option.label,
      })),
    );
    return map;
  }, [modelOptions, provider]);
  const effectiveProviderDefinitions = providerDefinitions;
  const effectiveAllProviderModels = allProviderModels ?? fallbackAllProviderModels;
  const canSelectProviderInModelMenu = canSelectModelProvider ?? (() => true);
  const comboboxThinkingOptions = useMemo<ComboboxOption[]>(
    () => (thinkingOptions ?? []).map((o) => ({ id: o.id, label: o.label })),
    [thinkingOptions],
  );

  const renderModeOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const visuals = getModeVisuals(provider, option.id, providerDefinitions);
      const IconComponent = visuals?.icon ? MODE_ICONS[visuals.icon] : ShieldCheck;
      return (
        <ComboboxItem
          label={option.label}
          selected={selected}
          active={active}
          onPress={onPress}
          leadingSlot={<IconComponent size={16} color={theme.colors.foreground} />}
        />
      );
    },
    [provider, providerDefinitions, theme.colors.foreground],
  );

  const handleOpenChange = useCallback(
    (selector: StatusSelector) => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null);
      if (!nextOpen) {
        onDropdownClose?.();
      }
    },
    [onDropdownClose],
  );

  const handleSelectorPress = useCallback(
    (selector: StatusSelector) => {
      handleOpenChange(selector)(openSelector !== selector);
    },
    [handleOpenChange, openSelector],
  );

  return (
    <View style={styles.container}>
      {platformIsWeb ? (
        <>
          {providerOptions && providerOptions.length > 0 ? (
            <>
              <Pressable
                ref={providerAnchorRef}
                collapsable={false}
                disabled={disabled || !canSelectProvider}
                onPress={() => handleSelectorPress("provider")}
                style={({ pressed, hovered }) => [
                  styles.modeBadge,
                  hovered && styles.modeBadgeHovered,
                  (pressed || openSelector === "provider") && styles.modeBadgePressed,
                  (disabled || !canSelectProvider) && styles.disabledBadge,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select agent provider"
                testID="agent-provider-selector"
              >
                <Text style={styles.modeBadgeText}>{displayProvider}</Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Combobox
                options={comboboxProviderOptions}
                value={selectedProviderId ?? ""}
                onSelect={(id) => onSelectProvider?.(id)}
                searchable={comboboxProviderOptions.length > SEARCH_THRESHOLD}
                open={openSelector === "provider"}
                onOpenChange={handleOpenChange("provider")}
                anchorRef={providerAnchorRef}
                desktopPlacement="top-start"
              />
            </>
          ) : null}

          {canSelectModel ? (
            <Tooltip
              key={`model-${displayModel}`}
              delayDuration={0}
              enabledOnDesktop
              enabledOnMobile={false}
            >
              <TooltipTrigger asChild triggerRefProp="ref">
                <View>
                  <CombinedModelSelector
                    providerDefinitions={effectiveProviderDefinitions}
                    allProviderModels={effectiveAllProviderModels}
                    selectedProvider={provider}
                    selectedModel={selectedModelId ?? ""}
                    canSelectProvider={canSelectProviderInModelMenu}
                    onSelect={(selectedProviderId, modelId) => {
                      if (selectedProviderId === provider) {
                        onSelectModel?.(modelId);
                      }
                    }}
                    favoriteKeys={favoriteKeys}
                    onToggleFavorite={onToggleFavoriteModel}
                    isLoading={isModelLoading}
                    disabled={modelDisabled}
                    onOpen={onModelSelectorOpen}
                    onClose={onDropdownClose}
                  />
                </View>
              </TooltipTrigger>
              <TooltipContent side="top" align="center" offset={8}>
                <Text style={styles.tooltipText}>{getStatusSelectorHint("model")}</Text>
              </TooltipContent>
            </Tooltip>
          ) : null}

          {thinkingOptions && thinkingOptions.length > 0 ? (
            <>
              <Tooltip
                key={`thinking-${openSelector === "thinking" ? "open" : "closed"}`}
                delayDuration={0}
                enabledOnDesktop
                enabledOnMobile={false}
              >
                <TooltipTrigger asChild triggerRefProp="ref">
                  <Pressable
                    ref={thinkingAnchorRef}
                    collapsable={false}
                    disabled={disabled || !canSelectThinking}
                    onPress={() => handleSelectorPress("thinking")}
                    style={({ pressed, hovered }) => [
                      styles.modeBadge,
                      hovered && styles.modeBadgeHovered,
                      (pressed || openSelector === "thinking") && styles.modeBadgePressed,
                      (disabled || !canSelectThinking) && styles.disabledBadge,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Select thinking option (${displayThinking})`}
                    testID="agent-thinking-selector"
                  >
                    <Brain size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                    <Text style={styles.modeBadgeText}>{displayThinking}</Text>
                    <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <Text style={styles.tooltipText}>{getStatusSelectorHint("thinking")}</Text>
                </TooltipContent>
              </Tooltip>
              <Combobox
                options={comboboxThinkingOptions}
                value={selectedThinkingOptionId ?? ""}
                onSelect={(id) => onSelectThinkingOption?.(id)}
                searchable={comboboxThinkingOptions.length > SEARCH_THRESHOLD}
                open={openSelector === "thinking"}
                onOpenChange={handleOpenChange("thinking")}
                anchorRef={thinkingAnchorRef}
                desktopPlacement="top-start"
              />
            </>
          ) : null}

          {modeOptions && modeOptions.length > 0 ? (
            <>
              <Tooltip
                key={`mode-${openSelector === "mode" ? "open" : "closed"}`}
                delayDuration={0}
                enabledOnDesktop
                enabledOnMobile={false}
              >
                <TooltipTrigger asChild triggerRefProp="ref">
                  <Pressable
                    ref={modeAnchorRef}
                    collapsable={false}
                    disabled={disabled || !canSelectMode}
                    onPress={() => handleSelectorPress("mode")}
                    style={({ pressed, hovered }) => [
                      styles.modeIconBadge,
                      hovered && styles.modeBadgeHovered,
                      (pressed || openSelector === "mode") && styles.modeBadgePressed,
                      (disabled || !canSelectMode) && styles.disabledBadge,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Select agent mode (${displayMode})`}
                    testID="agent-mode-selector"
                  >
                    {ModeIconComponent ? (
                      <ModeIconComponent size={theme.iconSize.md} color={modeIconColor} />
                    ) : (
                      <ShieldCheck size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                    )}
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <Text style={styles.tooltipText}>{getStatusSelectorHint("mode")}</Text>
                </TooltipContent>
              </Tooltip>
              <Combobox
                options={comboboxModeOptions}
                value={selectedModeId ?? ""}
                onSelect={(id) => onSelectMode?.(id)}
                searchable={comboboxModeOptions.length > SEARCH_THRESHOLD}
                open={openSelector === "mode"}
                onOpenChange={handleOpenChange("mode")}
                anchorRef={modeAnchorRef}
                desktopPlacement="top-start"
                renderOption={renderModeOption}
              />
            </>
          ) : null}

          {features?.map((feature) => {
            if (feature.type === "toggle") {
              const FeatureIcon = getFeatureIcon(feature.icon);
              return (
                <Tooltip
                  key={`feature-${feature.id}`}
                  delayDuration={0}
                  enabledOnDesktop
                  enabledOnMobile={false}
                >
                  <TooltipTrigger asChild triggerRefProp="ref">
                    <Pressable
                      disabled={disabled}
                      onPress={() => onSetFeature?.(feature.id, !feature.value)}
                      style={({ pressed, hovered }) => [
                        styles.modeIconBadge,
                        hovered && styles.modeBadgeHovered,
                        pressed && styles.modeBadgePressed,
                        disabled && styles.disabledBadge,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={getFeatureTooltip(feature)}
                      testID={`agent-feature-${feature.id}`}
                    >
                      <FeatureIcon
                        size={theme.iconSize.md}
                        color={getFeatureIconColor(
                          feature.id,
                          feature.value,
                          theme.colors.palette,
                          theme.colors.foregroundMuted,
                        )}
                      />
                    </Pressable>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="center" offset={8}>
                    <Text style={styles.tooltipText}>{getFeatureTooltip(feature)}</Text>
                  </TooltipContent>
                </Tooltip>
              );
            }
            if (feature.type === "select") {
              const FeatureIcon = getFeatureIcon(feature.icon);
              const selectedOption = feature.options.find((o) => o.id === feature.value);
              return (
                <DropdownMenu
                  key={`feature-${feature.id}`}
                  open={openSelector === `feature-${feature.id}`}
                  onOpenChange={handleOpenChange(`feature-${feature.id}`)}
                >
                  <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                    <TooltipTrigger asChild triggerRefProp="ref">
                      <DropdownMenuTrigger
                        disabled={disabled}
                        style={({ pressed, hovered }) => [
                          styles.modeBadge,
                          hovered && styles.modeBadgeHovered,
                          (pressed || openSelector === `feature-${feature.id}`) &&
                            styles.modeBadgePressed,
                          disabled && styles.disabledBadge,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={getFeatureTooltip(feature)}
                        testID={`agent-feature-${feature.id}`}
                      >
                        <FeatureIcon
                          size={theme.iconSize.md}
                          color={theme.colors.foregroundMuted}
                        />
                        <Text style={styles.modeBadgeText}>
                          {selectedOption?.label ?? feature.label}
                        </Text>
                        <ChevronDown
                          size={theme.iconSize.sm}
                          color={theme.colors.foregroundMuted}
                        />
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="center" offset={8}>
                      <Text style={styles.tooltipText}>{getFeatureTooltip(feature)}</Text>
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent side="top" align="start">
                    {feature.options.map((option) => (
                      <DropdownMenuItem
                        key={option.id}
                        selected={option.id === feature.value}
                        onSelect={() => onSetFeature?.(feature.id, option.id)}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }
            return null;
          })}
        </>
      ) : (
        <>
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setPrefsOpen(true);
            }}
            style={({ pressed }) => [styles.prefsButton, pressed && styles.prefsButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Agent preferences"
            testID="agent-preferences-button"
          >
            <ProviderIcon size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
            <Text style={styles.prefsButtonText} numberOfLines={1}>
              {displayModel}
            </Text>
          </Pressable>

          <AdaptiveModalSheet
            title="Preferences"
            visible={prefsOpen}
            onClose={() => setPrefsOpen(false)}
            stackBehavior="replace"
            testID="agent-preferences-sheet"
          >
            {canSelectModel ? (
              <View style={styles.sheetSection}>
                <CombinedModelSelector
                  providerDefinitions={effectiveProviderDefinitions}
                  allProviderModels={effectiveAllProviderModels}
                  selectedProvider={provider}
                  selectedModel={selectedModelId ?? ""}
                  canSelectProvider={canSelectProviderInModelMenu}
                  onSelect={(selectedProviderId, modelId) => {
                    if (onSelectProviderAndModel) {
                      onSelectProviderAndModel(selectedProviderId, modelId);
                    } else {
                      if (selectedProviderId !== provider) {
                        onSelectProvider?.(selectedProviderId);
                      }
                      onSelectModel?.(modelId);
                    }
                  }}
                  favoriteKeys={favoriteKeys}
                  onToggleFavorite={onToggleFavoriteModel}
                  isLoading={isModelLoading}
                  disabled={modelDisabled}
                  onOpen={onModelSelectorOpen}
                  onClose={onDropdownClose}
                  renderTrigger={({ selectedModelLabel }) => (
                    <View
                      style={[styles.sheetSelect, modelDisabled && styles.disabledSheetSelect]}
                      pointerEvents="none"
                      testID="agent-preferences-model"
                    >
                      <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                      <Text style={styles.sheetSelectText}>{selectedModelLabel}</Text>
                      <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                    </View>
                  )}
                />
              </View>
            ) : null}

            {thinkingOptions && thinkingOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu
                  open={openSelector === "thinking"}
                  onOpenChange={handleOpenChange("thinking")}
                >
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectThinking}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectThinking) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select thinking option"
                    testID="agent-preferences-thinking"
                  >
                    <Brain size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                    <Text style={styles.sheetSelectText}>{displayThinking}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {thinkingOptions.map((thinking) => (
                      <DropdownMenuItem
                        key={thinking.id}
                        selected={thinking.id === selectedThinkingOptionId}
                        onSelect={() => onSelectThinkingOption?.(thinking.id)}
                      >
                        {thinking.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}

            {modeOptions && modeOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu
                  open={openSelector === "mode"}
                  onOpenChange={handleOpenChange("mode")}
                >
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectMode}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectMode) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select agent mode"
                    testID="agent-preferences-mode"
                  >
                    {ModeIconComponent ? (
                      <ModeIconComponent size={theme.iconSize.md} color={modeIconColor} />
                    ) : null}
                    <Text style={styles.sheetSelectText}>{displayMode}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {modeOptions.map((mode) => {
                      const visuals = getModeVisuals(provider, mode.id, providerDefinitions);
                      const Icon = visuals?.icon ? MODE_ICONS[visuals.icon] : ShieldCheck;
                      return (
                        <DropdownMenuItem
                          key={mode.id}
                          selected={mode.id === selectedModeId}
                          onSelect={() => onSelectMode?.(mode.id)}
                          leading={<Icon size={16} color={theme.colors.foreground} />}
                        >
                          {mode.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}

            {features?.map((feature) => {
              if (feature.type === "toggle") {
                const FeatureIcon = getFeatureIcon(feature.icon);
                return (
                  <View key={`feature-${feature.id}`} style={styles.sheetSection}>
                    <Pressable
                      disabled={disabled}
                      onPress={() => onSetFeature?.(feature.id, !feature.value)}
                      style={({ pressed }) => [
                        styles.sheetSelect,
                        pressed && styles.sheetSelectPressed,
                        disabled && styles.disabledSheetSelect,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={getFeatureTooltip(feature)}
                      testID={`agent-feature-${feature.id}`}
                    >
                      <FeatureIcon
                        size={theme.iconSize.md}
                        color={getFeatureIconColor(
                          feature.id,
                          feature.value,
                          theme.colors.palette,
                          theme.colors.foregroundMuted,
                        )}
                      />
                      <Text style={styles.sheetSelectText}>{feature.label}</Text>
                      <Text style={styles.modeBadgeText}>{feature.value ? "On" : "Off"}</Text>
                    </Pressable>
                  </View>
                );
              }
              if (feature.type === "select") {
                const selectedOption = feature.options.find((o) => o.id === feature.value);
                return (
                  <View key={`feature-${feature.id}`} style={styles.sheetSection}>
                    <DropdownMenu
                      open={openSelector === `feature-${feature.id}`}
                      onOpenChange={handleOpenChange(`feature-${feature.id}`)}
                    >
                      <DropdownMenuTrigger
                        disabled={disabled}
                        style={({ pressed }) => [
                          styles.sheetSelect,
                          pressed && styles.sheetSelectPressed,
                          disabled && styles.disabledSheetSelect,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={getFeatureTooltip(feature)}
                        testID={`agent-feature-${feature.id}`}
                      >
                        <Text style={styles.sheetSelectText}>
                          {selectedOption?.label ?? feature.label}
                        </Text>
                        <ChevronDown
                          size={theme.iconSize.md}
                          color={theme.colors.foregroundMuted}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="start">
                        {feature.options.map((option) => (
                          <DropdownMenuItem
                            key={option.id}
                            selected={option.id === feature.value}
                            onSelect={() => onSetFeature?.(feature.id, option.id)}
                          >
                            {option.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </View>
                );
              }
              return null;
            })}
          </AdaptiveModalSheet>
        </>
      )}
    </View>
  );
}

const EMPTY_MODES: AgentMode[] = [];

export const AgentStatusBar = memo(function AgentStatusBar({
  agentId,
  serverId,
  onDropdownClose,
}: AgentStatusBarProps) {
  const { preferences, updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => {
      const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
      return currentAgent
        ? {
            provider: currentAgent.provider,
            cwd: currentAgent.cwd,
            currentModeId: currentAgent.currentModeId,
            runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
            model: currentAgent.model,
            features: currentAgent.features,
            thinkingOptionId: currentAgent.thinkingOptionId,
            lastUsage: currentAgent.lastUsage,
          }
        : null;
    }),
  );
  const availableModes = useStoreWithEqualityFn(
    useSessionStore,
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.availableModes ?? EMPTY_MODES,
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isFetching: snapshotIsFetching,
    invalidate: invalidateSnapshot,
  } = useProvidersSnapshot(serverId, agent?.cwd);

  const snapshotModels = useMemo(() => {
    if (!snapshotEntries || !agent?.provider) {
      return null;
    }
    const entry = snapshotEntries.find((e) => e.provider === agent.provider);
    return entry?.models ?? null;
  }, [snapshotEntries, agent?.provider]);

  const models = snapshotModels;

  const agentProviderDefinitions = useMemo(() => {
    const definition = agent?.provider
      ? resolveProviderDefinition(agent.provider, snapshotEntries)
      : undefined;
    return definition ? [definition] : [];
  }, [agent?.provider, snapshotEntries]);

  const agentProviderModels = useMemo(() => {
    const map = new Map<string, AgentModelDefinition[]>();
    if (agent?.provider && snapshotModels) {
      map.set(agent.provider, snapshotModels);
    }
    return map;
  }, [agent?.provider, snapshotModels]);

  const displayMode =
    availableModes.find((mode) => mode.id === agent?.currentModeId)?.label ||
    agent?.currentModeId ||
    "default";

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modeOptions = useMemo<StatusOption[]>(() => {
    return availableModes.map((mode) => ({
      id: mode.id,
      label: mode.label,
    }));
  }, [availableModes]);

  const modelOptions = useMemo<StatusOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);
  const favoriteKeys = useMemo(
    () =>
      new Set(
        (preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite)),
      ),
    [preferences.favoriteModels],
  );

  const thinkingOptions = useMemo<StatusOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: option.label,
    }));
  }, [modelSelection.thinkingOptions]);

  if (!agent) {
    return null;
  }

  return (
    <ControlledStatusBar
      provider={agent.provider}
      modeOptions={
        modeOptions.length > 0
          ? modeOptions
          : [{ id: agent.currentModeId ?? "", label: displayMode }]
      }
      selectedModeId={agent.currentModeId ?? undefined}
      providerDefinitions={agentProviderDefinitions}
      allProviderModels={agentProviderModels}
      onSelectMode={(modeId) => {
        if (!client) {
          return;
        }
        void client.setAgentMode(agentId, modeId).catch((error) => {
          console.warn("[AgentStatusBar] setAgentMode failed", error);
        });
      }}
      modelOptions={modelOptions}
      selectedModelId={modelSelection.activeModelId ?? undefined}
      onSelectModel={(modelId) => {
        if (!client) {
          return;
        }
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agent.provider,
            updates: {
              model: modelId,
            },
          }),
        ).catch((error) => {
          console.warn("[AgentStatusBar] persist model preference failed", error);
        });
        void client.setAgentModel(agentId, modelId).catch((error) => {
          console.warn("[AgentStatusBar] setAgentModel failed", error);
        });
      }}
      favoriteKeys={favoriteKeys}
      onToggleFavoriteModel={(provider, modelId) => {
        void updatePreferences((current) =>
          toggleFavoriteModel({ preferences: current, provider, modelId }),
        ).catch((error) => {
          console.warn("[AgentStatusBar] toggle favorite model failed", error);
        });
      }}
      thinkingOptions={thinkingOptions.length > 1 ? thinkingOptions : undefined}
      selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
      onSelectThinkingOption={(thinkingOptionId) => {
        if (!client) {
          return;
        }
        const activeModelId = modelSelection.activeModelId;
        if (activeModelId) {
          void updatePreferences((current) =>
            mergeProviderPreferences({
              preferences: current,
              provider: agent.provider,
              updates: {
                model: activeModelId,
                thinkingByModel: {
                  [activeModelId]: thinkingOptionId,
                },
              },
            }),
          ).catch((error) => {
            console.warn("[AgentStatusBar] persist thinking preference failed", error);
          });
        }
        void client.setAgentThinkingOption(agentId, thinkingOptionId).catch((error) => {
          console.warn("[AgentStatusBar] setAgentThinkingOption failed", error);
        });
      }}
      features={agent.features}
      onSetFeature={(featureId, value) => {
        if (!client) {
          return;
        }
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agent.provider,
            updates: {
              featureValues: {
                [featureId]: value,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentStatusBar] persist feature preference failed", error);
        });
        void client.setAgentFeature(agentId, featureId, value).catch((error) => {
          console.warn("[AgentStatusBar] setAgentFeature failed", error);
        });
      }}
      isModelLoading={snapshotIsLoading || snapshotIsFetching}
      onModelSelectorOpen={invalidateSnapshot}
      onDropdownClose={onDropdownClose}
      disabled={!client}
    />
  );
});

export function DraftAgentStatusBar({
  providerDefinitions,
  selectedProvider,
  onSelectProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  isModelLoading,
  allProviderModels,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  disabled = false,
}: DraftAgentStatusBarProps) {
  const { preferences, updatePreferences } = useFormPreferences();

  const mappedModeOptions = useMemo<StatusOption[]>(() => {
    if (modeOptions.length === 0) {
      return [{ id: "", label: "Default" }];
    }
    return modeOptions.map((mode) => ({
      id: mode.id,
      label: mode.label,
    }));
  }, [modeOptions]);

  const mappedThinkingOptions = useMemo<StatusOption[]>(() => {
    return thinkingOptions.map((option) => ({ id: option.id, label: option.label }));
  }, [thinkingOptions]);
  const favoriteKeys = useMemo(
    () =>
      new Set(
        (preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite)),
      ),
    [preferences.favoriteModels],
  );

  const effectiveSelectedMode = selectedMode || mappedModeOptions[0]?.id || "";
  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined;

  if (platformIsWeb) {
    return (
      <View style={styles.container}>
        <CombinedModelSelector
          providerDefinitions={providerDefinitions}
          allProviderModels={allProviderModels}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          onSelect={onSelectProviderAndModel}
          favoriteKeys={favoriteKeys}
          onToggleFavorite={(provider, modelId) => {
            void updatePreferences((current) =>
              toggleFavoriteModel({ preferences: current, provider, modelId }),
            ).catch((error) => {
              console.warn("[DraftAgentStatusBar] toggle favorite model failed", error);
            });
          }}
          isLoading={isAllModelsLoading}
          disabled={disabled}
          onOpen={onModelSelectorOpen}
          onClose={onDropdownClose}
        />
        <ControlledStatusBar
          provider={selectedProvider}
          providerDefinitions={providerDefinitions}
          modeOptions={mappedModeOptions}
          selectedModeId={effectiveSelectedMode}
          onSelectMode={onSelectMode}
          thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
          selectedThinkingOptionId={effectiveSelectedThinkingOption}
          onSelectThinkingOption={onSelectThinkingOption}
          features={features}
          onSetFeature={onSetFeature}
          onDropdownClose={onDropdownClose}
          disabled={disabled}
        />
      </View>
    );
  }

  const modelOptions: StatusOption[] = models.map((model) => ({
    id: model.id,
    label: model.label,
  }));

  return (
    <>
      <ControlledStatusBar
        provider={selectedProvider}
        providerDefinitions={providerDefinitions}
        allProviderModels={allProviderModels}
        modeOptions={mappedModeOptions}
        selectedModeId={effectiveSelectedMode}
        onSelectMode={onSelectMode}
        modelOptions={modelOptions}
        selectedModelId={selectedModel}
        onSelectModel={(modelId) => onSelectModel(modelId)}
        onSelectProviderAndModel={onSelectProviderAndModel}
        isModelLoading={isAllModelsLoading}
        favoriteKeys={favoriteKeys}
        onToggleFavoriteModel={(provider, modelId) => {
          void updatePreferences((current) =>
            toggleFavoriteModel({ preferences: current, provider, modelId }),
          ).catch((error) => {
            console.warn("[DraftAgentStatusBar] toggle favorite model failed", error);
          });
        }}
        thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
        selectedThinkingOptionId={effectiveSelectedThinkingOption}
        onSelectThinkingOption={onSelectThinkingOption}
        features={features}
        onSetFeature={onSetFeature}
        onModelSelectorOpen={onModelSelectorOpen}
        disabled={disabled}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  modeBadge: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeIconBadge: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabledBadge: {
    opacity: 0.5,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  prefsButton: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  prefsButtonPressed: {
    backgroundColor: theme.colors.surface0,
  },
  prefsButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 1,
  },
  sheetSection: {
    gap: theme.spacing[2],
  },
  sheetSelect: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
  },
  sheetSelectPressed: {
    backgroundColor: theme.colors.surface2,
  },
  disabledSheetSelect: {
    opacity: 0.5,
  },
  sheetSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
}));
