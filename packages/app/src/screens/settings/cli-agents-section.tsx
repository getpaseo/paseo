import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Plus,
  RotateCw,
  TerminalSquare,
  Trash2,
  Power,
  PowerOff,
  Wrench,
} from "lucide-react-native";
import {
  isBuiltInCliProviderId,
  listCliProviders,
  type CliProviderOverrides,
} from "@server/shared/cli-provider-registry";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { CliAgentIcon } from "@/components/icons/cli-agent-icon";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useCliAgents } from "@/hooks/use-cli-agents";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

type PromptDeliveryMode = "none" | "positional" | "flag";

type CliAgentDraft = {
  id: string;
  name: string;
  command: string;
  versionArgs: string;
  defaultArgs: string;
  autoApproveFlag: string;
  initialPromptFlag: string;
  resumeFlag: string;
  installCommand: string;
  docUrl: string;
  promptDeliveryMode: PromptDeliveryMode;
  detectable: "on" | "off";
};

const EMPTY_DRAFT: CliAgentDraft = {
  id: "",
  name: "",
  command: "",
  versionArgs: "--version",
  defaultArgs: "",
  autoApproveFlag: "",
  initialPromptFlag: "",
  resumeFlag: "",
  installCommand: "",
  docUrl: "",
  promptDeliveryMode: "none",
  detectable: "on",
};

function slugifyCliProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function parseArgList(value: string): string[] | undefined {
  const parts = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function buildCustomCliProviderFromDraft(draft: CliAgentDraft): CliProviderOverrides[string] {
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    versionArgs: parseArgList(draft.versionArgs),
    defaultArgs: parseArgList(draft.defaultArgs),
    autoApproveFlag: draft.autoApproveFlag.trim() || undefined,
    initialPromptFlag:
      draft.promptDeliveryMode === "none"
        ? undefined
        : draft.promptDeliveryMode === "positional"
          ? ""
          : draft.initialPromptFlag.trim(),
    resumeFlag: draft.resumeFlag.trim() || undefined,
    installCommand: draft.installCommand.trim() || undefined,
    docUrl: draft.docUrl.trim() || undefined,
    detectable: draft.detectable === "on",
    enabled: true,
  };
}

function statusTone(
  value: "connected" | "missing" | "error" | "disabled",
): "success" | "error" | "muted" {
  if (value === "connected") {
    return "success";
  }
  if (value === "error") {
    return "error";
  }
  return "muted";
}

export function CliAgentsSection({ routeServerId }: { routeServerId: string }) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(routeServerId);
  const { config, patchConfig } = useDaemonConfig(routeServerId);
  const { agents, isLoading, isFetching, error, refresh } = useCliAgents(routeServerId);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [draft, setDraft] = useState<CliAgentDraft>(EMPTY_DRAFT);
  const [hasManuallyEditedId, setHasManuallyEditedId] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const cliProviderOverrides = config?.agents?.cliProviders ?? {};

  const providerDefinitions = useMemo(
    () => listCliProviders({ overrides: cliProviderOverrides, includeDisabled: true }),
    [cliProviderOverrides],
  );
  const statusById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const existingIds = useMemo(
    () => new Set(providerDefinitions.map((provider) => provider.id)),
    [providerDefinitions],
  );

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setHasManuallyEditedId(false);
  }, []);

  useEffect(() => {
    if (!isCreateModalOpen) {
      resetDraft();
    }
  }, [isCreateModalOpen, resetDraft]);

  const replaceCliProviders = useCallback(
    async (nextCliProviders: CliProviderOverrides) => {
      await patchConfig({
        agents: {
          cliProviders: nextCliProviders,
        },
      });
    },
    [patchConfig],
  );

  const handleToggle = useCallback(
    async (providerId: string, nextEnabled: boolean) => {
      const nextOverrides: CliProviderOverrides = {
        ...cliProviderOverrides,
        [providerId]: {
          ...(cliProviderOverrides[providerId] ?? {}),
          enabled: nextEnabled,
        },
      };

      setIsSaving(true);
      try {
        await replaceCliProviders(nextOverrides);
        refresh();
      } catch (toggleError) {
        console.error("[Settings] Failed to update CLI agent state", toggleError);
        Alert.alert("Error", "Unable to update this CLI agent.");
      } finally {
        setIsSaving(false);
      }
    },
    [cliProviderOverrides, refresh, replaceCliProviders],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const nextOverrides: CliProviderOverrides = { ...cliProviderOverrides };
      delete nextOverrides[providerId];

      setIsSaving(true);
      try {
        await replaceCliProviders(nextOverrides);
      } catch (deleteError) {
        console.error("[Settings] Failed to delete CLI agent", deleteError);
        Alert.alert("Error", "Unable to delete this CLI agent.");
      } finally {
        setIsSaving(false);
      }
    },
    [cliProviderOverrides, replaceCliProviders],
  );

  const handleCreate = useCallback(async () => {
    const providerId = draft.id.trim();
    const providerName = draft.name.trim();
    const command = draft.command.trim();

    if (!providerId || !providerName || !command) {
      Alert.alert("Missing fields", "Fill in name, ID, and command before creating the CLI agent.");
      return;
    }

    if (existingIds.has(providerId)) {
      Alert.alert("ID already in use", "Choose a different ID for this CLI agent.");
      return;
    }

    const nextOverrides: CliProviderOverrides = {
      ...cliProviderOverrides,
      [providerId]: buildCustomCliProviderFromDraft(draft),
    };

    setIsSaving(true);
    try {
      await replaceCliProviders(nextOverrides);
      setIsCreateModalOpen(false);
      refresh();
    } catch (createError) {
      console.error("[Settings] Failed to create CLI agent", createError);
      Alert.alert("Error", "Unable to create this CLI agent.");
    } finally {
      setIsSaving(false);
    }
  }, [cliProviderOverrides, draft, existingIds, refresh, replaceCliProviders]);

  const rows = useMemo(() => {
    return providerDefinitions.map((provider) => {
      const override = cliProviderOverrides[provider.id];
      const enabled = override?.enabled !== false;
      const detection = enabled ? statusById.get(provider.id) : null;
      const isCustom = !isBuiltInCliProviderId(provider.id);
      const effectiveCommand = provider.cli ?? provider.commands?.[0] ?? "Not configured";
      const badgeLabel = !enabled
        ? "Disabled"
        : detection?.status === "connected"
          ? "Available"
          : detection?.status === "error"
            ? "Error"
            : "Not installed";
      const detectionState: "connected" | "missing" | "error" | "disabled" = !enabled
        ? "disabled"
        : detection?.status === "connected" || detection?.status === "error"
          ? detection.status
          : "missing";

      return {
        provider,
        isCustom,
        enabled,
        detection,
        effectiveCommand,
        badgeLabel,
        detectionState,
      };
    });
  }, [cliProviderOverrides, providerDefinitions, statusById]);

  const canCreate =
    draft.id.trim().length > 0 &&
    draft.name.trim().length > 0 &&
    draft.command.trim().length > 0 &&
    !existingIds.has(draft.id.trim());

  if (routeServerId.length === 0 || !isConnected) {
    return (
      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionTitle}>CLI Agents</Text>
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>Connect to a host to manage terminal agents.</Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <View style={settingsStyles.section}>
        <View style={settingsStyles.sectionHeader}>
          <Text style={settingsStyles.sectionHeaderTitle}>CLI Agents</Text>
          <View style={styles.sectionActions}>
            <Pressable
              onPress={refresh}
              disabled={isFetching}
              style={[settingsStyles.sectionHeaderLink, isFetching ? { opacity: 0.5 } : null]}
            >
              <RotateCw size={theme.iconSize.sm} color={theme.colors.primary} />
              <Text style={settingsStyles.sectionHeaderLinkText}>Refresh</Text>
            </Pressable>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={Plus}
              onPress={() => setIsCreateModalOpen(true)}
            >
              Add CLI agent
            </Button>
          </View>
        </View>

        <View style={[settingsStyles.card, styles.summaryCard]}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryIcon}>
              <TerminalSquare size={16} color={theme.colors.foregroundMuted} />
            </View>
            <View style={styles.summaryCopy}>
              <Text style={styles.summaryTitle}>Manage terminal-based coding agents</Text>
              <Text style={styles.summaryText}>
                Enable built-ins, disable items you do not want in the picker, or add custom CLI
                agents that run from a local command.
              </Text>
            </View>
          </View>
        </View>

        {error ? (
          <View style={[settingsStyles.card, styles.errorCard]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Loading CLI agents...</Text>
          </View>
        ) : (
          <View style={[settingsStyles.card, styles.listCard]}>
            {rows.map((row, index) => {
              const provider = row.provider;
              return (
                <View
                  key={provider.id}
                  style={[styles.agentRow, index > 0 ? styles.agentRowBorder : null]}
                >
                  <View style={styles.agentAvatar}>
                    <CliAgentIcon icon={provider.icon} size={20} color={theme.colors.foreground} />
                  </View>
                  <View style={styles.agentRowMain}>
                    <View style={styles.agentRowHeader}>
                      <View style={styles.agentTitleBlock}>
                        <Text style={styles.agentTitle}>{provider.name}</Text>
                        <View style={styles.agentMetaRow}>
                          <StatusBadge
                            label={row.badgeLabel}
                            variant={statusTone(row.detectionState)}
                          />
                          <View style={styles.kindPill}>
                            <Text style={styles.kindPillText}>
                              {row.isCustom ? "Custom" : "Built-in"}
                            </Text>
                          </View>
                        </View>
                      </View>
                      <View style={styles.rowActions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          leftIcon={row.enabled ? PowerOff : Power}
                          onPress={() => void handleToggle(provider.id, !row.enabled)}
                          disabled={isSaving}
                        >
                          {row.enabled ? "Disable" : "Enable"}
                        </Button>
                        {row.isCustom ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            leftIcon={Trash2}
                            onPress={() =>
                              Alert.alert("Delete CLI agent", `Delete ${provider.name}?`, [
                                { text: "Cancel", style: "cancel" },
                                {
                                  text: "Delete",
                                  style: "destructive",
                                  onPress: () => {
                                    void handleDelete(provider.id);
                                  },
                                },
                              ])
                            }
                            disabled={isSaving}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </View>
                    </View>

                    <Text style={styles.agentCommand} numberOfLines={1}>
                      {row.effectiveCommand}
                    </Text>
                    {row.detection?.path ? (
                      <Text style={styles.agentHint} numberOfLines={1}>
                        Installed at {row.detection.path}
                      </Text>
                    ) : row.enabled ? (
                      <Text style={styles.agentHint} numberOfLines={2}>
                        {row.detection?.installCommand ??
                          provider.installCommand ??
                          "This CLI agent was not detected on the current host."}
                      </Text>
                    ) : (
                      <Text style={styles.agentHint} numberOfLines={2}>
                        Disabled agents stay hidden from task creation until re-enabled.
                      </Text>
                    )}

                    <View style={styles.agentFooter}>
                      {row.detection?.version ? (
                        <Text style={styles.agentFooterText}>v{row.detection.version}</Text>
                      ) : null}
                      {provider.initialPromptFlag !== undefined ? (
                        <View style={styles.footerPill}>
                          <Wrench size={10} color={theme.colors.foregroundMuted} />
                          <Text style={styles.footerPillText}>
                            Prompt{" "}
                            {provider.initialPromptFlag.length > 0
                              ? provider.initialPromptFlag
                              : "positional"}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <AdaptiveModalSheet
        title="Add CLI Agent"
        visible={isCreateModalOpen}
        onClose={() => {
          if (!isSaving) {
            setIsCreateModalOpen(false);
          }
        }}
      >
        <View style={styles.formField}>
          <Text style={styles.label}>Name</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.name}
            onChangeText={(value) => {
              setDraft((current) => ({
                ...current,
                name: value,
                id: hasManuallyEditedId ? current.id : slugifyCliProviderId(value),
              }));
            }}
            placeholder="My CLI Agent"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>ID</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.id}
            onChangeText={(value) => {
              setHasManuallyEditedId(true);
              setDraft((current) => ({ ...current, id: slugifyCliProviderId(value) }));
            }}
            placeholder="my-cli-agent"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
          <Text style={styles.helpText}>
            Lowercase letters, numbers, and hyphens only. This ID appears in the agent picker.
          </Text>
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Command</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.command}
            onChangeText={(value) => setDraft((current) => ({ ...current, command: value }))}
            placeholder="my-agent"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Prompt delivery</Text>
          <SegmentedControl
            size="sm"
            value={draft.promptDeliveryMode}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                promptDeliveryMode: value as PromptDeliveryMode,
              }))
            }
            options={[
              { value: "none", label: "None" },
              { value: "positional", label: "Positional" },
              { value: "flag", label: "Flag" },
            ]}
          />
        </View>

        {draft.promptDeliveryMode === "flag" ? (
          <View style={styles.formField}>
            <Text style={styles.label}>Prompt flag</Text>
            <AdaptiveTextInput
              style={styles.input}
              value={draft.initialPromptFlag}
              onChangeText={(value) =>
                setDraft((current) => ({ ...current, initialPromptFlag: value }))
              }
              placeholder="-i"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
            />
          </View>
        ) : null}

        <View style={styles.formField}>
          <Text style={styles.label}>Version args</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.versionArgs}
            onChangeText={(value) => setDraft((current) => ({ ...current, versionArgs: value }))}
            placeholder="--version"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Default args</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.defaultArgs}
            onChangeText={(value) => setDraft((current) => ({ ...current, defaultArgs: value }))}
            placeholder="run -s"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Auto-approve flag</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.autoApproveFlag}
            onChangeText={(value) =>
              setDraft((current) => ({ ...current, autoApproveFlag: value }))
            }
            placeholder="--yolo"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Resume flag</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.resumeFlag}
            onChangeText={(value) => setDraft((current) => ({ ...current, resumeFlag: value }))}
            placeholder="--resume"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Install command</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.installCommand}
            onChangeText={(value) => setDraft((current) => ({ ...current, installCommand: value }))}
            placeholder="npm install -g my-agent"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Docs URL</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draft.docUrl}
            onChangeText={(value) => setDraft((current) => ({ ...current, docUrl: value }))}
            placeholder="https://example.com/docs"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Detectable</Text>
          <SegmentedControl
            size="sm"
            value={draft.detectable}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, detectable: value as "on" | "off" }))
            }
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
          <Text style={styles.helpText}>
            Turn this off if the command cannot answer a version check reliably.
          </Text>
        </View>

        <View style={styles.modalActions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.modalActionButton}
            onPress={() => setIsCreateModalOpen(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            style={styles.modalActionButton}
            onPress={() => void handleCreate()}
            disabled={!canCreate || isSaving}
          >
            Create CLI agent
          </Button>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryCard: {
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  summaryRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    alignItems: "flex-start",
  },
  summaryIcon: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  summaryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  summaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  listCard: {
    overflow: "hidden",
  },
  agentAvatar: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  agentRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  agentRowMain: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  agentRowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  agentTitleBlock: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  agentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  agentMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  kindPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  kindPillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentCommand: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  agentHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  agentFooter: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  agentFooterText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  footerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  footerPillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyCard: {
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorCard: {
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
    borderColor: theme.colors.palette.red[500],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  formField: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  helpText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  modalActionButton: {
    flex: 1,
  },
}));
