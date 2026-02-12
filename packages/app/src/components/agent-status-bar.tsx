import { View, Text, Platform, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Brain, ChevronDown, SlidersHorizontal } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
}

function normalizeModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized || normalized.toLowerCase() === "default") {
    return null;
  }
  return normalized;
}

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
  const { theme } = useUnistyles();
  const IS_WEB = Platform.OS === "web";
  const [prefsOpen, setPrefsOpen] = useState(false);
  const dropdownMaxWidth = IS_WEB ? 360 : undefined;

  // Select only the specific agent (not all agents)
  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  if (!agent) {
    return null;
  }

  const canFetchModels = Boolean(client) && Boolean(agent.provider) && (IS_WEB || prefsOpen);
  const modelsQuery = useQuery({
    queryKey: ["providerModels", serverId, agent.provider, agent.cwd],
    enabled: canFetchModels,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.listProviderModels(agent.provider, { cwd: agent.cwd });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.models ?? [];
    },
  });
  const models = modelsQuery.data ?? null;

  function handleModeChange(modeId: string) {
    if (!client) {
      return;
    }
    void client.setAgentMode(agentId, modeId).catch((error) => {
      console.warn("[AgentStatusBar] setAgentMode failed", error);
    });
  }

  const normalizedRuntimeModelId = normalizeModelId(agent.runtimeInfo?.model);
  const normalizedConfiguredModelId = normalizeModelId(agent.model);
  const preferredModelId = normalizedRuntimeModelId ?? normalizedConfiguredModelId;
  const selectedModel = useMemo(() => {
    if (!models || !preferredModelId) return null;
    return models.find((m) => m.id === preferredModelId) ?? null;
  }, [models, preferredModelId]);

  const activeModelId = selectedModel?.id ?? preferredModelId ?? null;
  const displayModel = selectedModel ? selectedModel.label : preferredModelId ?? "Auto";

  const thinkingOptions = selectedModel?.thinkingOptions ?? null;
  const explicitThinkingId =
    agent.thinkingOptionId && agent.thinkingOptionId !== "default"
      ? agent.thinkingOptionId
      : null;
  const selectedThinkingId =
    explicitThinkingId ?? selectedModel?.defaultThinkingOptionId ?? null;
  const selectedThinking = thinkingOptions?.find((o) => o.id === selectedThinkingId) ?? null;
  const displayThinking =
    selectedThinking?.label ??
    (selectedThinkingId === "default" ? "Model default" : selectedThinkingId ?? "auto");

  const displayMode =
    agent.availableModes?.find((m) => m.id === agent.currentModeId)?.label ||
    agent.currentModeId ||
    "default";

  return (
    <View style={[styles.container, IS_WEB && { marginBottom: -theme.spacing[1] }]}>
      {/* Agent Mode Badge (desktop only — on mobile, mode is in the preferences sheet) */}
      {IS_WEB && agent.availableModes && agent.availableModes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            style={({ pressed, hovered, open }) => [
              styles.modeBadge,
              hovered && styles.modeBadgeHovered,
              (pressed || open) && styles.modeBadgePressed,
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
            maxWidth={dropdownMaxWidth}
            testID="agent-mode-menu"
          >
            {agent.availableModes.map((mode) => {
              const isActive = mode.id === agent.currentModeId;
              return (
                <DropdownMenuItem
                  key={mode.id}
                  selected={isActive}
                  onSelect={() => handleModeChange(mode.id)}
                >
                  {mode.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Desktop: inline dropdowns for model/thinking */}
      {IS_WEB && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={({ pressed, hovered, open }) => [
                styles.modeBadge,
                hovered && styles.modeBadgeHovered,
                (pressed || open) && styles.modeBadgePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Select agent model"
              testID="agent-model-selector"
            >
              <Text style={styles.modeBadgeText}>{displayModel}</Text>
              <ChevronDown size={14} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              maxWidth={dropdownMaxWidth}
              testID="agent-model-menu"
            >
              {models?.map((model) => {
                const isActive = model.id === activeModelId;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    selected={isActive}
                    onSelect={() => {
                      if (!client) {
                        return;
                      }
                      void client.setAgentModel(agentId, model.id).catch((error) => {
                        console.warn("[AgentStatusBar] setAgentModel failed", error);
                      });
                    }}
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
                style={({ pressed, hovered, open }) => [
                  styles.modeBadge,
                  hovered && styles.modeBadgeHovered,
                  (pressed || open) && styles.modeBadgePressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Select thinking option"
                testID="agent-thinking-selector"
              >
                <Brain size={12} color={theme.colors.foregroundMuted} style={{ marginTop: 1 }} />
                <Text style={styles.modeBadgeText}>{displayThinking}</Text>
                <ChevronDown size={14} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                maxWidth={dropdownMaxWidth}
                testID="agent-thinking-menu"
              >
                {thinkingOptions.map((opt) => {
                  const isActive = opt.id === selectedThinkingId;
                  return (
                    <DropdownMenuItem
                      key={opt.id}
                      selected={isActive}
                      onSelect={() => {
                        if (!client) {
                          return;
                        }
                        void client
                          .setAgentThinkingOption(agentId, opt.id)
                          .catch((error) => {
                            console.warn("[AgentStatusBar] setAgentThinkingOption failed", error);
                          });
                      }}
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
            <SlidersHorizontal size={20} color={theme.colors.foreground} />
          </Pressable>

          <AdaptiveModalSheet
            title="Preferences"
            visible={prefsOpen}
            onClose={() => setPrefsOpen(false)}
            testID="agent-preferences-sheet"
          >
            {agent.availableModes && agent.availableModes.length > 0 && (
              <View style={styles.sheetSection}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    style={({ pressed }) => [
                      styles.sheetSelect,
                      pressed && styles.sheetSelectPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Select agent mode"
                    testID="agent-preferences-mode"
                  >
                    <Text style={styles.sheetSelectText}>{displayMode}</Text>
                    <ChevronDown size={16} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    {agent.availableModes.map((mode) => {
                      const isActive = mode.id === agent.currentModeId;
                      return (
                        <DropdownMenuItem
                          key={mode.id}
                          selected={isActive}
                          onSelect={() => handleModeChange(mode.id)}
                        >
                          {mode.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            )}

            <View style={styles.sheetSection}>
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
                  {models?.map((model) => {
                    const isActive = model.id === activeModelId;
                    return (
                      <DropdownMenuItem
                        key={model.id}
                        selected={isActive}
                        onSelect={() => {
                          if (!client) {
                            return;
                          }
                          void client.setAgentModel(agentId, model.id).catch((error) => {
                            console.warn("[AgentStatusBar] setAgentModel failed", error);
                          });
                        }}
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
                    {thinkingOptions.map((opt) => {
                      const isActive = opt.id === selectedThinkingId;
                      return (
                        <DropdownMenuItem
                          key={opt.id}
                          selected={isActive}
                          onSelect={() => {
                            if (!client) {
                              return;
                            }
                            void client
                              .setAgentThinkingOption(agentId, opt.id)
                              .catch((error) => {
                                console.warn("[AgentStatusBar] setAgentThinkingOption failed", error);
                              });
                          }}
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
    gap: theme.spacing[1],
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  prefsButton: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  prefsButtonPressed: {
    backgroundColor: theme.colors.surface0,
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
  sheetSelectText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
}));
