import { View, Text, Platform, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, SlidersHorizontal } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useEffect, useMemo, useState } from "react";

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
}

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
  const { theme } = useUnistyles();
  const IS_WEB = Platform.OS === "web";
  const [prefsOpen, setPrefsOpen] = useState(false);

  // Select only the specific agent (not all agents)
  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  const providerModelState = useSessionStore((state) =>
    state.sessions[serverId]?.providerModels?.get(agent?.provider as any)
  );

  // Get actions (actions are stable, won't cause rerenders)
  const setAgentMode = useSessionStore(
    (state) => state.sessions[serverId]?.methods?.setAgentMode
  );
  const setAgentModel = useSessionStore(
    (state) => state.sessions[serverId]?.methods?.setAgentModel
  );
  const setAgentThinkingOption = useSessionStore(
    (state) => state.sessions[serverId]?.methods?.setAgentThinkingOption
  );
  const requestProviderModels = useSessionStore(
    (state) => state.sessions[serverId]?.methods?.requestProviderModels
  );

  if (!agent) {
    return null;
  }

  function handleModeChange(modeId: string) {
    if (setAgentMode) {
      setAgentMode(agentId, modeId);
    }
  }

  const models = providerModelState?.models ?? null;
  const selectedModel = useMemo(() => {
    if (!models || !agent.model) return null;
    return models.find((m) => m.id === agent.model) ?? null;
  }, [models, agent.model]);

  const displayModel = selectedModel?.label ?? agent.model ?? "default";

  const thinkingOptions = selectedModel?.thinkingOptions ?? null;
  const selectedThinkingId =
    agent.thinkingOptionId ??
    selectedModel?.defaultThinkingOptionId ??
    "default";
  const selectedThinking = thinkingOptions?.find((o) => o.id === selectedThinkingId) ?? null;
  const displayThinking = selectedThinking?.label ?? selectedThinkingId ?? "default";

  useEffect(() => {
    if (!requestProviderModels) return;
    const provider = agent.provider;
    if (!provider) return;

    const hasState = Boolean(providerModelState);
    const isLoading = providerModelState?.isLoading ?? false;
    const hasModels = Boolean(providerModelState?.models);
    const shouldFetch = !hasState || (!hasModels && !isLoading);
    if (!shouldFetch) return;
    if (IS_WEB || prefsOpen) {
      requestProviderModels(provider, { cwd: agent.cwd });
    }
  }, [IS_WEB, prefsOpen, agent.provider, agent.cwd, providerModelState, requestProviderModels]);

  return (
    <View style={styles.container}>
      {/* Agent Mode Badge */}
      {agent.availableModes && agent.availableModes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            style={({ pressed }) => [
              styles.modeBadge,
              pressed && styles.modeBadgePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Select agent mode"
            testID="agent-mode-selector"
          >
            <Text style={styles.modeBadgeText}>
              {agent.availableModes?.find((m) => m.id === agent.currentModeId)
                ?.label ||
                agent.currentModeId ||
                "default"}
            </Text>
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            testID="agent-mode-menu"
          >
            <DropdownMenuLabel>Mode</DropdownMenuLabel>
            {agent.availableModes.map((mode) => {
              const isActive = mode.id === agent.currentModeId;
              return (
                <DropdownMenuItem
                  key={mode.id}
                  selected={isActive}
                  selectedVariant="accent"
                  description={mode.description}
                  onSelect={() => handleModeChange(mode.id)}
                >
                  {mode.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Desktop: inline dropdowns for model/thinking/variant */}
      {IS_WEB && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={({ pressed }) => [
                styles.modeBadge,
                pressed && styles.modeBadgePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Select agent model"
              testID="agent-model-selector"
            >
              <Text style={styles.modeBadgeText}>{displayModel}</Text>
              <ChevronDown size={14} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" testID="agent-model-menu">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              {models?.map((model) => {
                const isActive = model.id === agent.model;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    selected={isActive}
                    selectedVariant="accent"
                    description={model.description}
                    onSelect={() => setAgentModel?.(agentId, model.id)}
                  >
                    {model.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {thinkingOptions && thinkingOptions.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ pressed }) => [
                  styles.modeBadge,
                  pressed && styles.modeBadgePressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select thinking option"
                testID="agent-thinking-selector"
              >
                <Text style={styles.modeBadgeText}>{displayThinking}</Text>
                <ChevronDown size={14} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" testID="agent-thinking-menu">
                <DropdownMenuLabel>Thinking</DropdownMenuLabel>
                {thinkingOptions.map((opt) => {
                  const isActive = opt.id === selectedThinkingId;
                  return (
                    <DropdownMenuItem
                      key={opt.id}
                      selected={isActive}
                      selectedVariant="accent"
                      description={opt.description}
                      onSelect={() =>
                        setAgentThinkingOption?.(
                          agentId,
                          opt.id === "default" ? null : opt.id
                        )
                      }
                    >
                      {opt.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

        </>
      )}

      {/* Mobile: preferences button opens a bottom sheet */}
      {!IS_WEB && (
        <>
          <Pressable
            onPress={() => setPrefsOpen(true)}
            style={({ pressed }) => [
              styles.prefsButton,
              pressed && styles.prefsButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Agent preferences"
            testID="agent-preferences-button"
          >
            <SlidersHorizontal size={16} color={theme.colors.foregroundMuted} />
          </Pressable>

          <AdaptiveModalSheet
            title="Preferences"
            visible={prefsOpen}
            onClose={() => setPrefsOpen(false)}
            testID="agent-preferences-sheet"
          >
            <View style={styles.sheetSection}>
              <Text style={styles.sheetLabel}>Model</Text>
              <DropdownMenu>
                <DropdownMenuTrigger
                  style={({ pressed }) => [
                    styles.sheetSelect,
                    pressed && styles.sheetSelectPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Select agent model"
                  testID="agent-preferences-model"
                >
                  <Text style={styles.sheetSelectText}>{displayModel}</Text>
                  <ChevronDown size={16} color={theme.colors.foregroundMuted} />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start">
                  <DropdownMenuLabel>Model</DropdownMenuLabel>
                  {models?.map((model) => {
                    const isActive = model.id === agent.model;
                    return (
                      <DropdownMenuItem
                        key={model.id}
                        selected={isActive}
                        selectedVariant="accent"
                        description={model.description}
                        onSelect={() => setAgentModel?.(agentId, model.id)}
                      >
                        {model.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </View>

            {thinkingOptions && thinkingOptions.length > 1 && (
              <View style={styles.sheetSection}>
                <Text style={styles.sheetLabel}>Thinking</Text>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select thinking option"
                    testID="agent-preferences-thinking"
                  >
                    <Text style={styles.sheetSelectText}>{displayThinking}</Text>
                    <ChevronDown size={16} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    <DropdownMenuLabel>Thinking</DropdownMenuLabel>
                    {thinkingOptions.map((opt) => {
                      const isActive = opt.id === selectedThinkingId;
                      return (
                        <DropdownMenuItem
                          key={opt.id}
                          selected={isActive}
                          selectedVariant="accent"
                          description={opt.description}
                          onSelect={() =>
                            setAgentThinkingOption?.(
                              agentId,
                              opt.id === "default" ? null : opt.id
                            )
                          }
                        >
                          {opt.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            )}

          </AdaptiveModalSheet>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "capitalize",
  },
  prefsButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius["2xl"],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  prefsButtonPressed: {
    backgroundColor: theme.colors.surface0,
  },
  sheetSection: {
    gap: theme.spacing[2],
  },
  sheetLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
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
  sheetSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
