import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Platform, Pressable, Keyboard } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Brain, ChevronDown, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react-native";
import { getProviderIcon } from "@/components/provider-icons";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
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
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import {
  AGENT_PROVIDER_DEFINITIONS,
  getModeVisuals,
  type AgentModeColorTier,
  type AgentModeIcon,
} from "@server/server/agent/provider-manifest";
import {
  getStatusSelectorHint,
  resolveAgentModelSelection,
} from "@/components/agent-status-bar.utils";
import { isProviderModelsQueryLoading } from "@/components/agent-status-bar.model-loading";

type StatusOption = {
  id: string;
  label: string;
};

type StatusSelector = "provider" | "mode" | "model" | "thinking";

const PROVIDER_DEFINITION_MAP = new Map(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

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
  thinkingOptions?: StatusOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  providerDefinitions?: AgentProviderDefinition[];
  allProviderModels?: Map<string, AgentModelDefinition[]>;
  canSelectModelProvider?: (providerId: string) => boolean;
  favoriteKeys?: Set<string>;
  onToggleFavoriteModel?: (provider: string, modelId: string) => void;
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
  disabled?: boolean;
}

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
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
}: ControlledAgentStatusBarProps) {
  const { theme } = useUnistyles();
  const isWeb = Platform.OS === "web";
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

  const modeVisuals = selectedModeId ? getModeVisuals(provider, selectedModeId) : undefined;
  const ModeIconComponent = modeVisuals?.icon ? MODE_ICONS[modeVisuals.icon] : null;
  const modeIconColor = getModeIconColor(modeVisuals?.colorTier, theme.colors.palette);
  const ProviderIcon = getProviderIcon(provider);

  const hasAnyControl =
    Boolean(providerOptions?.length) ||
    Boolean(modeOptions?.length) ||
    canSelectModel ||
    Boolean(thinkingOptions?.length);

  if (!hasAnyControl) {
    return null;
  }

  const modelDisabled = disabled || isModelLoading || !modelOptions || modelOptions.length === 0;

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
  const effectiveProviderDefinitions = providerDefinitions ??
    (PROVIDER_DEFINITION_MAP.has(provider) ? [PROVIDER_DEFINITION_MAP.get(provider)!] : []);
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
      const visuals = getModeVisuals(provider, option.id);
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
    [provider, theme.colors.foreground],
  );

  const handleOpenChange = useCallback(
    (selector: StatusSelector) => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null);
    },
    [],
  );

  const handleSelectorPress = useCallback(
    (selector: StatusSelector) => {
      handleOpenChange(selector)(openSelector !== selector);
    },
    [handleOpenChange, openSelector],
  );

  return (
    <View style={styles.container}>
      {isWeb ? (
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
            {providerOptions && providerOptions.length > 0 ? (
              <View style={styles.sheetSection}>
                <DropdownMenu
                  open={openSelector === "provider"}
                  onOpenChange={handleOpenChange("provider")}
                >
                  <DropdownMenuTrigger
                    disabled={disabled || !canSelectProvider}
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                      (disabled || !canSelectProvider) && styles.disabledSheetSelect,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select agent provider"
                    testID="agent-preferences-provider"
                  >
                    <Text style={styles.sheetSelectText}>{displayProvider}</Text>
                    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {providerOptions.map((provider) => (
                      <DropdownMenuItem
                        key={provider.id}
                        selected={provider.id === selectedProviderId}
                        onSelect={() => onSelectProvider?.(provider.id)}
                      >
                        {provider.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}

            {canSelectModel ? (
              <View style={styles.sheetSection}>
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
                  renderTrigger={({ selectedModelLabel }) => (
                    <View
                      style={[
                        styles.sheetSelect,
                        modelDisabled && styles.disabledSheetSelect,
                      ]}
                      pointerEvents="none"
                      testID="agent-preferences-model"
                    >
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
                      const visuals = getModeVisuals(provider, mode.id);
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
          </AdaptiveModalSheet>
        </>
      )}
    </View>
  );
}

const EMPTY_MODES: AgentMode[] = [];

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
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
            thinkingOptionId: currentAgent.thinkingOptionId,
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

  const modelsQuery = useQuery({
    queryKey: ["providerModels", serverId, agent?.provider ?? "__missing_provider__"],
    enabled: Boolean(client && agent?.provider),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !agent) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.listProviderModels(agent.provider, { cwd: agent.cwd });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.models ?? [];
    },
  });

  const availableProvidersQuery = useQuery({
    queryKey: ["availableProviders", serverId],
    enabled: Boolean(client),
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.listAvailableProviders();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.providers.filter((entry) => entry.available).map((entry) => entry.provider);
    },
  });

  const availableProviderDefinitions = useMemo(() => {
    const availableProviders = availableProvidersQuery.data;
    if (!availableProviders) {
      return [];
    }
    const available = new Set(availableProviders);
    return AGENT_PROVIDER_DEFINITIONS.filter((definition) => available.has(definition.id));
  }, [availableProvidersQuery.data]);

  const allProviderModelQueries = useQueries({
    queries: availableProviderDefinitions.map((definition) => ({
      queryKey: ["providerModels", serverId, definition.id, agent?.cwd ?? ""],
      enabled: Boolean(client && agent?.cwd),
      staleTime: 5 * 60 * 1000,
      queryFn: async () => {
        if (!client || !agent) {
          throw new Error("Daemon client unavailable");
        }
        const payload = await client.listProviderModels(definition.id, { cwd: agent.cwd });
        if (payload.error) {
          throw new Error(payload.error);
        }
        return payload.models ?? [];
      },
    })),
  });

  const liveAllProviderModels = useMemo(() => {
    const map = new Map<string, AgentModelDefinition[]>();
    for (let i = 0; i < availableProviderDefinitions.length; i++) {
      const query = allProviderModelQueries[i];
      if (query?.data) {
        map.set(availableProviderDefinitions[i]!.id, query.data);
      }
    }
    return map;
  }, [allProviderModelQueries, availableProviderDefinitions]);

  const models = modelsQuery.data ?? null;

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
    () => new Set((preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite))),
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
        modeOptions.length > 0 ? modeOptions : [{ id: agent.currentModeId ?? "", label: displayMode }]
      }
      selectedModeId={agent.currentModeId ?? undefined}
      providerDefinitions={availableProviderDefinitions}
      allProviderModels={liveAllProviderModels}
      canSelectModelProvider={(providerId) => providerId === agent.provider}
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
        void updatePreferences(
          mergeProviderPreferences({
            preferences,
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
        void updatePreferences(toggleFavoriteModel({ preferences, provider, modelId })).catch((error) => {
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
          void updatePreferences(
            mergeProviderPreferences({
              preferences,
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
      isModelLoading={isProviderModelsQueryLoading(modelsQuery)}
      disabled={!client}
    />
  );
}

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
  disabled = false,
}: DraftAgentStatusBarProps) {
  const isWeb = Platform.OS === "web";
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
    () => new Set((preferences.favoriteModels ?? []).map((favorite) => buildFavoriteModelKey(favorite))),
    [preferences.favoriteModels],
  );

  const effectiveSelectedMode = selectedMode || mappedModeOptions[0]?.id || "";
  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined;

  if (isWeb) {
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
            void updatePreferences(toggleFavoriteModel({ preferences, provider, modelId })).catch((error) => {
              console.warn("[DraftAgentStatusBar] toggle favorite model failed", error);
            });
          }}
          isLoading={isAllModelsLoading}
          disabled={disabled}
        />
        <ControlledStatusBar
          provider={selectedProvider}
          modeOptions={mappedModeOptions}
          selectedModeId={effectiveSelectedMode}
          onSelectMode={onSelectMode}
          thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
          selectedThinkingOptionId={effectiveSelectedThinkingOption}
          onSelectThinkingOption={onSelectThinkingOption}
          disabled={disabled}
        />
      </View>
    );
  }

  const providerOptions = providerDefinitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
  }));

  const modelOptions: StatusOption[] = [];
  for (const model of models) {
    modelOptions.push({ id: model.id, label: model.label });
  }

  return (
    <ControlledStatusBar
      provider={selectedProvider}
      providerOptions={providerOptions}
      selectedProviderId={selectedProvider}
      onSelectProvider={(providerId) => onSelectProvider(providerId as AgentProvider)}
      modeOptions={mappedModeOptions}
      selectedModeId={effectiveSelectedMode}
      onSelectMode={onSelectMode}
      modelOptions={modelOptions}
      selectedModelId={selectedModel}
      onSelectModel={onSelectModel}
      isModelLoading={isModelLoading}
      favoriteKeys={favoriteKeys}
      onToggleFavoriteModel={(provider, modelId) => {
        void updatePreferences(toggleFavoriteModel({ preferences, provider, modelId })).catch((error) => {
          console.warn("[DraftAgentStatusBar] toggle favorite model failed", error);
        });
      }}
      thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
      selectedThinkingOptionId={effectiveSelectedThinkingOption}
      onSelectThinkingOption={onSelectThinkingOption}
      disabled={disabled}
    />
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
