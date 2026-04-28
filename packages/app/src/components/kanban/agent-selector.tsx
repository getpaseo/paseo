import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, Alert } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, MessageSquare, Terminal, Wrench } from "lucide-react-native";
import { getCliProvider } from "@server/shared/cli-provider-registry";
import { CliAgentIcon } from "@/components/icons/cli-agent-icon";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import type { CliAgentStatus } from "@/hooks/use-cli-agents";
import { useHubcodeModels } from "@/hooks/use-hubcode-models";
import { authServerBaseUrl } from "@/desktop/auth/web-auth-api";
import { openExternalUrl } from "@/utils/open-external-url";

export type AgentMode = "native" | "cli";

export interface AgentSelection {
  id: string;
  mode: AgentMode;
  label: string;
}

export type NativeProviderId = "claude" | "codex" | "copilot" | "opencode" | "pi";

export interface NativeProviderConfig {
  id: NativeProviderId;
  label: string;
  description: string;
}

export const NATIVE_PROVIDERS: NativeProviderConfig[] = [
  { id: "claude", label: "Claude Code", description: "Anthropic — GUI chat with MCP" },
  { id: "codex", label: "Codex", description: "OpenAI — GUI chat with sandbox" },
  { id: "copilot", label: "Copilot", description: "GitHub — GUI chat via ACP" },
  { id: "opencode", label: "OpenCode", description: "Open-source — GUI chat" },
  { id: "pi", label: "Pi", description: "Minimal coding agent" },
];

interface AgentOption extends ComboboxOption {
  selectionId: string;
  mode: AgentMode;
  agentId: string;
  subtitle?: string;
  modeLabel: string;
  sectionLabel: string;
  showSectionHeader?: boolean;
  installed: boolean;
  cliIcon?: string;
}

interface AgentSelectorProps {
  value: AgentSelection;
  onChange: (selection: AgentSelection) => void;
  disabled?: boolean;
  cliAgents?: CliAgentStatus[];
  availableNativeProviders?: NativeProviderId[];
  /** When true, renders a compact pill trigger instead of the large card. */
  compact?: boolean;
  /** When true (with compact), renders icon + chevron only — no label. */
  iconOnly?: boolean;
}

function buildOptionId(mode: AgentMode, id: string): string {
  return `${mode}:${id}`;
}

function getModeLabel(mode: AgentMode): string {
  return mode === "cli" ? "CLI" : "GUI";
}

function getSectionLabel(mode: AgentMode): string {
  return mode === "cli" ? "Runs in terminal" : "Runs in Hubcode chat";
}

export function AgentSelector({
  value,
  onChange,
  disabled = false,
  cliAgents = [],
  availableNativeProviders,
  compact = false,
  iconOnly = false,
}: AgentSelectorProps) {
  const { theme } = useUnistyles();
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const { bundle: hubcodeBundle, requiresSignIn: hubcodeRequiresSignIn } = useHubcodeModels();

  const hubcodeStatus = useMemo<
    "available" | "requires-signin" | "requires-upgrade" | "hidden"
  >(() => {
    if (hubcodeRequiresSignIn) return "requires-signin";
    if (!hubcodeBundle) return "hidden";
    if (hubcodeBundle.requiresUpgrade) return "requires-upgrade";
    return "available";
  }, [hubcodeBundle, hubcodeRequiresSignIn]);

  const handleHubcodeUnavailable = useCallback(() => {
    if (hubcodeStatus === "requires-signin") {
      void openExternalUrl(`${authServerBaseUrl()}/sign-in/web`).catch(() => {});
      return;
    }
    if (hubcodeStatus === "requires-upgrade") {
      Alert.alert(
        "Upgrade required",
        "The Hubcode agent is available on Pro and Enterprise plans. Upgrade your plan to unlock it.",
        [{ text: "OK" }],
      );
    }
  }, [hubcodeStatus]);

  const options = useMemo<AgentOption[]>(() => {
    const nativeOptions: AgentOption[] = (
      availableNativeProviders
        ? NATIVE_PROVIDERS.filter((provider) => availableNativeProviders.includes(provider.id))
        : NATIVE_PROVIDERS
    ).map((provider) => ({
      id: buildOptionId("native", provider.id),
      selectionId: buildOptionId("native", provider.id),
      agentId: provider.id,
      mode: "native",
      label: provider.label,
      description: provider.description,
      subtitle: "Built-in provider",
      modeLabel: getModeLabel("native"),
      sectionLabel: getSectionLabel("native"),
      installed: true,
    }));

    if (hubcodeStatus !== "hidden") {
      const hubcodeOption: AgentOption = {
        id: buildOptionId("native", "hubcode"),
        selectionId: buildOptionId("native", "hubcode"),
        agentId: "hubcode",
        mode: "native",
        label: "Hubcode",
        description:
          hubcodeStatus === "available"
            ? "Curated multi-model routing"
            : hubcodeStatus === "requires-signin"
              ? "Sign in to unlock"
              : "Upgrade to Pro to unlock",
        subtitle:
          hubcodeStatus === "available"
            ? "Built-in — your plan's combos"
            : hubcodeStatus === "requires-signin"
              ? "Sign in to Hubcode"
              : "Available on Pro & Enterprise",
        modeLabel: getModeLabel("native"),
        sectionLabel: getSectionLabel("native"),
        installed: hubcodeStatus === "available",
      };
      nativeOptions.unshift(hubcodeOption);
    }

    const cliOptions: AgentOption[] = cliAgents.map((agent) => ({
      id: buildOptionId("cli", agent.id),
      selectionId: buildOptionId("cli", agent.id),
      agentId: agent.id,
      mode: "cli",
      label: agent.name,
      description:
        agent.status === "connected"
          ? agent.version
            ? `Installed · v${agent.version}`
            : "Installed"
          : "Install required",
      subtitle:
        agent.status === "connected"
          ? "Detected on this host"
          : (agent.installCommand ?? "This CLI agent is not available on this host"),
      modeLabel: getModeLabel("cli"),
      sectionLabel: getSectionLabel("cli"),
      installed: agent.status === "connected",
      cliIcon: getCliProvider(agent.id)?.icon,
    }));

    return [
      ...nativeOptions.map((option, index) => ({
        ...option,
        showSectionHeader: index === 0,
      })),
      ...cliOptions.map((option, index) => ({
        ...option,
        showSectionHeader: index === 0,
      })),
    ];
  }, [availableNativeProviders, cliAgents, hubcodeStatus]);

  const selectedOptionId = buildOptionId(value.mode, value.id);
  const selectedOption =
    options.find((option) => option.selectionId === selectedOptionId) ??
    ({
      id: selectedOptionId,
      selectionId: selectedOptionId,
      agentId: value.id,
      mode: value.mode,
      label: value.label,
      description: value.mode === "cli" ? "CLI agent" : "Built-in provider",
      subtitle: getSectionLabel(value.mode),
      modeLabel: getModeLabel(value.mode),
      sectionLabel: getSectionLabel(value.mode),
      installed: true,
      cliIcon: value.mode === "cli" ? getCliProvider(value.id)?.icon : undefined,
    } satisfies AgentOption);

  const SelectedIcon =
    selectedOption.mode === "native" ? getProviderIcon(selectedOption.agentId) : null;

  return (
    <View ref={anchorRef} collapsable={false}>
      {compact ? (
        <Pressable
          onPress={() => {
            if (!disabled) {
              setIsOpen(true);
            }
          }}
          style={({ pressed, hovered }) => [
            styles.compactTrigger,
            hovered && styles.compactTriggerHovered,
            pressed && styles.compactTriggerPressed,
            disabled && styles.triggerDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Select agent (${selectedOption.label})`}
        >
          {selectedOption.mode === "native" && SelectedIcon ? (
            <SelectedIcon size={14} color={theme.colors.foregroundMuted} />
          ) : (
            <CliAgentIcon
              icon={selectedOption.cliIcon}
              size={14}
              color={theme.colors.foregroundMuted}
            />
          )}
          {!iconOnly ? (
            <Text style={styles.compactTriggerLabel} numberOfLines={1}>
              {selectedOption.label}
            </Text>
          ) : null}
          {!iconOnly && selectedOption.mode === "cli" ? (
            <Terminal size={11} color={theme.colors.foregroundMuted} />
          ) : null}
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : (
        <Pressable
          onPress={() => {
            if (!disabled) {
              setIsOpen(true);
            }
          }}
          style={({ pressed, hovered }) => [
            styles.trigger,
            hovered && styles.triggerHovered,
            pressed && styles.triggerPressed,
            disabled && styles.triggerDisabled,
          ]}
        >
          <View style={styles.triggerIconWrap}>
            {selectedOption.mode === "native" && SelectedIcon ? (
              <SelectedIcon size={16} color={theme.colors.foreground} />
            ) : (
              <CliAgentIcon
                icon={selectedOption.cliIcon}
                size={16}
                color={theme.colors.foreground}
              />
            )}
          </View>
          <View style={styles.triggerTextWrap}>
            <View style={styles.triggerTopRow}>
              <Text style={styles.triggerLabel} numberOfLines={1}>
                {selectedOption.label}
              </Text>
              <View
                style={[
                  styles.modeBadge,
                  selectedOption.mode === "cli" ? styles.modeBadgeCli : styles.modeBadgeNative,
                ]}
              >
                {selectedOption.mode === "cli" ? (
                  <Terminal size={11} color={theme.colors.foregroundMuted} />
                ) : (
                  <MessageSquare size={11} color={theme.colors.foregroundMuted} />
                )}
                <Text style={styles.modeBadgeText}>{selectedOption.modeLabel}</Text>
              </View>
            </View>
            <Text style={styles.triggerDescription} numberOfLines={1}>
              {selectedOption.description ?? selectedOption.sectionLabel}
            </Text>
          </View>
          <ChevronDown size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}

      <Combobox
        options={options}
        value={selectedOptionId}
        onSelect={(optionId) => {
          const nextOption = options.find((option) => option.selectionId === optionId);
          if (!nextOption) return;
          if (
            nextOption.mode === "native" &&
            nextOption.agentId === "hubcode" &&
            hubcodeStatus !== "available"
          ) {
            handleHubcodeUnavailable();
            return;
          }
          if (!nextOption.installed) {
            return;
          }
          onChange({
            id: nextOption.agentId,
            mode: nextOption.mode,
            label: nextOption.label,
          });
          setIsOpen(false);
        }}
        searchable
        searchPlaceholder="Search agents..."
        emptyText="No agents match your search."
        title="Choose agent"
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={360}
        stickyHeader={
          <View style={styles.stickyHeader}>
            <View style={styles.legendRow}>
              <View style={styles.legendPill}>
                <MessageSquare size={11} color={theme.colors.foregroundMuted} />
                <Text style={styles.legendText}>GUI chat</Text>
              </View>
              <View style={styles.legendPill}>
                <Terminal size={11} color={theme.colors.foregroundMuted} />
                <Text style={styles.legendText}>CLI terminal</Text>
              </View>
            </View>
          </View>
        }
        renderOption={({ option, selected, active, onPress }) => {
          const agentOption = option as AgentOption;
          const OptionIcon =
            agentOption.mode === "native" ? getProviderIcon(agentOption.agentId) : null;

          return (
            <View key={agentOption.selectionId} style={styles.optionBlock}>
              {agentOption.showSectionHeader ? (
                <View style={styles.optionHeaderRow}>
                  <Text style={styles.optionSectionText}>{agentOption.sectionLabel}</Text>
                </View>
              ) : null}
              <ComboboxItem
                label={agentOption.label}
                description={agentOption.description}
                selected={selected}
                active={active}
                disabled={!agentOption.installed}
                elevated
                onPress={onPress}
                leadingSlot={
                  agentOption.mode === "native" && OptionIcon ? (
                    <OptionIcon size={16} color={theme.colors.foregroundMuted} />
                  ) : (
                    <CliAgentIcon
                      icon={agentOption.cliIcon}
                      size={16}
                      color={theme.colors.foregroundMuted}
                    />
                  )
                }
                trailingSlot={
                  <View style={styles.optionMeta}>
                    <View
                      style={[
                        styles.optionModeChip,
                        agentOption.mode === "cli"
                          ? styles.optionModeChipCli
                          : styles.optionModeChipNative,
                      ]}
                    >
                      <Text style={styles.optionModeChipText}>{agentOption.modeLabel}</Text>
                    </View>
                    {!agentOption.installed ? (
                      <View style={styles.optionInstallChip}>
                        <Wrench size={10} color={theme.colors.foregroundMuted} />
                        <Text style={styles.optionInstallChipText}>Install</Text>
                      </View>
                    ) : null}
                  </View>
                }
              />
              {agentOption.subtitle ? (
                <Text
                  style={[
                    styles.optionSubtitle,
                    !agentOption.installed && styles.optionSubtitleDisabled,
                  ]}
                  numberOfLines={1}
                >
                  {agentOption.subtitle}
                </Text>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

export function defaultAgentSelection(): AgentSelection {
  return { id: "claude", mode: "native", label: "Claude Code" };
}

export type Agent = NativeProviderId;

export const AGENT_CONFIG: Record<string, { name: string; label: string }> = Object.fromEntries(
  NATIVE_PROVIDERS.map((provider) => [
    provider.id,
    { name: provider.label, label: provider.label },
  ]),
);

const styles = StyleSheet.create((theme) => ({
  compactTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1] + 2,
    borderRadius: theme.borderRadius.full,
  },
  compactTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  compactTriggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  compactTriggerLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  trigger: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerIconWrap: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  },
  triggerTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  triggerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  triggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  triggerDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    flexShrink: 0,
  },
  modeBadgeNative: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.surface2,
  },
  modeBadgeCli: {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
  },
  modeBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  stickyHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  legendPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  legendText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  optionBlock: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  optionHeaderRow: {
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  optionSectionText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  optionMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionModeChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  optionModeChipNative: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.surface2,
  },
  optionModeChipCli: {
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
  },
  optionModeChipText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  optionInstallChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  optionInstallChipText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  optionSubtitle: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  optionSubtitleDisabled: {
    opacity: 0.65,
  },
}));
