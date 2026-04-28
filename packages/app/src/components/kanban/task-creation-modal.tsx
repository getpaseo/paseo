// TaskCreationModal — adapted from emdash's TaskModal + TaskAdvancedSettings
// Uses AdaptiveModalSheet for cross-platform modal (mobile bottom sheet, desktop modal)

import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { ChevronDown, ChevronUp, Settings } from "lucide-react-native";
import type { KanbanTask, IntegrationId, TaskIntegrationContext } from "@/types/kanban";
import { INTEGRATION_REGISTRY } from "@/types/kanban";
import { generateFriendlyTaskName, normalizeTaskName } from "@/lib/task-names";
import { useSessionStore } from "@/stores/session-store";
import { IntegrationSelector } from "../integrations/integration-selector";
import { AgentSelector, defaultAgentSelection, type AgentSelection } from "./agent-selector";
import { useCliAgents } from "@/hooks/use-cli-agents";
import { useIntegrationStatus } from "@/hooks/use-integration-status";
import type {
  ForgejoIssueSummary,
  GitHubIssueSummary,
  GitLabIssueSummary,
  JiraIssueSummary,
  LinearIssueSummary,
  PlainThreadSummary,
  SentryIssueSummary,
  TaskMetadata,
} from "@/types/integrations";
import { buildTaskAgentPrompt } from "@/lib/task-agent-prompt";

interface TaskCreationModalProps {
  visible: boolean;
  onClose: () => void;
  onTaskCreated?: (input: TaskCreationSubmission) => void | Promise<void>;
  serverId?: string;
  projectId?: string;
  projectName?: string;
  workspacePath?: string;
  baseBranch?: string;
}

export interface TaskCreationSubmission {
  task: KanbanTask | null;
  taskName: string;
  prompt?: string;
  metadata?: TaskMetadata;
  integrations?: TaskIntegrationContext;
  autoApprove: boolean;
  useWorktree: boolean;
  serverId?: string;
  projectId?: string;
  projectName?: string;
  workspacePath?: string;
  linkToTask: boolean;
  agentSelection: AgentSelection;
}

function deriveTaskNameFromIntegrationItem(
  integrationId: IntegrationId,
  item: Record<string, unknown> | undefined,
): string | null {
  if (!item) {
    return null;
  }

  const identifier = String(item.identifier ?? item.key ?? item.number ?? "").trim();
  const title = String(item.title ?? item.previewText ?? item.name ?? "").trim();
  const rawName =
    identifier && title
      ? `${integrationId}-${identifier}-${title}`
      : identifier || title || String(item.id ?? "").trim();
  const normalized = normalizeTaskName(rawName);
  return normalized || null;
}

function castIntegrationItem<T>(item: Record<string, unknown> | undefined): T | undefined {
  return item as unknown as T | undefined;
}

export function TaskCreationModal({
  visible,
  onClose,
  onTaskCreated,
  serverId,
  projectId,
  projectName,
  workspacePath,
  baseBranch,
}: TaskCreationModalProps) {
  const { theme } = useUnistyles();
  const sessionWorkspaces = useSessionStore((state) => state.sessions[serverId ?? ""]?.workspaces);
  const existingNames = useMemo(() => {
    if (!sessionWorkspaces) return [];
    return Array.from(sessionWorkspaces.values()).map((w) => w.name);
  }, [sessionWorkspaces]);
  const isWorkspaceCreation = Boolean(workspacePath);
  const modalTitle = isWorkspaceCreation ? "New Workspace" : "New Task";
  const nameLabel = isWorkspaceCreation ? "Workspace name" : "Task name";
  const namePlaceholder = isWorkspaceCreation ? "e.g. fix-login-bug" : "e.g. fix-login-bug";
  const createLabel = isWorkspaceCreation ? "Create workspace" : "Create task";
  const initialTaskNameRef = useRef(generateFriendlyTaskName(existingNames));
  const [taskName, setTaskName] = useState(initialTaskNameRef.current);
  const [prompt, setPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [integrations, setIntegrations] = useState<TaskIntegrationContext>({});
  const [integrationItems, setIntegrationItems] = useState<
    Partial<Record<IntegrationId, Record<string, unknown>>>
  >({});
  const [agentSelection, setAgentSelection] = useState<AgentSelection>(defaultAgentSelection);
  const [isCreating, setIsCreating] = useState(false);
  const lastAutoTaskNameRef = useRef(initialTaskNameRef.current);
  const lastAutoPromptRef = useRef("");

  // CLI agents detection
  const { agents: cliAgentsList } = useCliAgents(serverId ?? null);

  // Integration connection status
  const { isConnected: isIntegrationConnected } = useIntegrationStatus(serverId);

  const resetForm = useCallback(() => {
    const nextTaskName = generateFriendlyTaskName(existingNames);
    initialTaskNameRef.current = nextTaskName;
    lastAutoTaskNameRef.current = nextTaskName;
    setTaskName(nextTaskName);
    setPrompt("");
    setShowAdvanced(false);
    setAutoApprove(false);
    setUseWorktree(true);
    setIntegrations({});
    setIntegrationItems({});
    setAgentSelection(defaultAgentSelection());
    setIsCreating(false);
    lastAutoPromptRef.current = "";
  }, [existingNames]);

  const metadata = useMemo<TaskMetadata | undefined>(() => {
    const nextMetadata: TaskMetadata = {};

    const linearIssue = castIntegrationItem<LinearIssueSummary>(integrationItems.linear);
    if (linearIssue) {
      nextMetadata.linearIssue = linearIssue;
    }
    const githubIssue = castIntegrationItem<GitHubIssueSummary>(integrationItems.github);
    if (githubIssue) {
      nextMetadata.githubIssue = githubIssue;
    }
    const jiraIssue = castIntegrationItem<JiraIssueSummary>(integrationItems.jira);
    if (jiraIssue) {
      nextMetadata.jiraIssue = jiraIssue;
    }
    const gitlabIssue = castIntegrationItem<GitLabIssueSummary>(integrationItems.gitlab);
    if (gitlabIssue) {
      nextMetadata.gitlabIssue = gitlabIssue;
    }
    const plainThread = castIntegrationItem<PlainThreadSummary>(integrationItems.plain);
    if (plainThread) {
      nextMetadata.plainThread = plainThread;
    }
    const forgejoIssue = castIntegrationItem<ForgejoIssueSummary>(integrationItems.forgejo);
    if (forgejoIssue) {
      nextMetadata.forgejoIssue = forgejoIssue;
    }
    const sentryIssue = castIntegrationItem<SentryIssueSummary>(integrationItems.sentry);
    if (sentryIssue) {
      nextMetadata.sentryIssue = sentryIssue;
    }

    return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
  }, [integrationItems]);

  const handleCreate = useCallback(async () => {
    if (!taskName.trim()) return;

    console.log(`[TaskCreationModal] handleCreate called`, {
      taskName: taskName.trim(),
      integrations,
      integrationKeys: Object.keys(integrations),
      integrationValues: integrations,
      hasMetadata: !!metadata,
      metadataKeys: metadata ? Object.keys(metadata) : [],
    });

    setIsCreating(true);
    try {
      const finalPrompt = buildTaskAgentPrompt({
        prompt,
        metadata,
      });

      await onTaskCreated?.({
        task: null,
        taskName: taskName.trim(),
        prompt: finalPrompt,
        metadata,
        integrations: Object.keys(integrations).length > 0 ? integrations : undefined,
        autoApprove,
        useWorktree,
        serverId,
        projectId,
        projectName,
        workspacePath,
        linkToTask: true,
        agentSelection,
      });
      resetForm();
      onClose();
    } catch {
      setIsCreating(false);
    }
  }, [
    taskName,
    prompt,
    metadata,
    autoApprove,
    useWorktree,
    integrations,
    agentSelection,
    workspacePath,
    serverId,
    projectId,
    projectName,
    onTaskCreated,
    resetForm,
    onClose,
  ]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleIntegrationChange = useCallback(
    (integrationId: IntegrationId, value: string | undefined) => {
      console.log(`[TaskCreationModal] handleIntegrationChange`, {
        integrationId,
        value,
      });
      setIntegrations((prev) => {
        // Map integration ID to the correct TaskIntegrationContext key.
        // Most use `${id}IssueId`, but Plain uses `plainThreadId`.
        const key: keyof TaskIntegrationContext =
          integrationId === "plain"
            ? "plainThreadId"
            : (`${integrationId}IssueId` as keyof TaskIntegrationContext);
        if (!value) {
          const { [key]: _, ...rest } = prev;
          console.log(`[TaskCreationModal] integrations cleared:`, { key, next: rest });
          return rest;
        }
        const next = { ...prev, [key]: value };
        console.log(`[TaskCreationModal] integrations set:`, { key, value, next });
        return next;
      });
    },
    [],
  );

  const handleIntegrationItemChange = useCallback(
    (integrationId: IntegrationId, item: Record<string, unknown> | undefined) => {
      const nextItems = item
        ? { ...integrationItems, [integrationId]: item }
        : Object.fromEntries(
            Object.entries(integrationItems).filter(([key]) => key !== integrationId),
          );
      setIntegrationItems((prev) => {
        if (!item) {
          const { [integrationId]: _, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [integrationId]: item,
        };
      });

      const nextMetadata: TaskMetadata = {};
      if (nextItems.linear) {
        nextMetadata.linearIssue = castIntegrationItem<LinearIssueSummary>(nextItems.linear);
      }
      if (nextItems.github) {
        nextMetadata.githubIssue = castIntegrationItem<GitHubIssueSummary>(nextItems.github);
      }
      if (nextItems.jira) {
        nextMetadata.jiraIssue = castIntegrationItem<JiraIssueSummary>(nextItems.jira);
      }
      if (nextItems.gitlab) {
        nextMetadata.gitlabIssue = castIntegrationItem<GitLabIssueSummary>(nextItems.gitlab);
      }
      if (nextItems.plain) {
        nextMetadata.plainThread = castIntegrationItem<PlainThreadSummary>(nextItems.plain);
      }
      if (nextItems.forgejo) {
        nextMetadata.forgejoIssue = castIntegrationItem<ForgejoIssueSummary>(nextItems.forgejo);
      }
      if (nextItems.sentry) {
        nextMetadata.sentryIssue = castIntegrationItem<SentryIssueSummary>(nextItems.sentry);
      }

      setPrompt((current) => {
        const trimmedCurrent = current.trim();
        if (trimmedCurrent && trimmedCurrent !== lastAutoPromptRef.current.trim()) {
          return current;
        }

        const autoPrompt =
          buildTaskAgentPrompt({
            metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
          }) ?? "";
        lastAutoPromptRef.current = autoPrompt;
        return autoPrompt;
      });

      let autoTaskName = deriveTaskNameFromIntegrationItem(integrationId, item);
      if (!autoTaskName) {
        return;
      }

      // Deduplicate: if a workspace with this name already exists, add a numeric suffix
      if (existingNames.includes(autoTaskName)) {
        let suffix = 2;
        while (existingNames.includes(`${autoTaskName}-${suffix}`)) {
          suffix++;
        }
        autoTaskName = `${autoTaskName}-${suffix}`;
      }

      setTaskName((current) => {
        const trimmedCurrent = current.trim();
        if (trimmedCurrent && trimmedCurrent !== lastAutoTaskNameRef.current.trim()) {
          return current;
        }
        lastAutoTaskNameRef.current = autoTaskName;
        return autoTaskName;
      });
    },
    [existingNames, integrationItems],
  );

  return (
    <AdaptiveModalSheet
      title={modalTitle}
      visible={visible}
      onClose={handleClose}
      snapPoints={["75%", "95%"]}
      testID="task-creation-modal"
    >
      {/* Workspace info */}
      {workspacePath ? (
        <View style={modalStyles.infoRow}>
          <Text style={modalStyles.infoLabel} numberOfLines={1}>
            {workspacePath.split("/").pop() || workspacePath}
          </Text>
          {baseBranch ? <Text style={modalStyles.infoSub}>from {baseBranch}</Text> : null}
        </View>
      ) : null}

      {/* Task name */}
      <View style={modalStyles.fieldGroup}>
        <Text style={modalStyles.label}>{nameLabel}</Text>
        <AdaptiveTextInput
          style={modalStyles.textInput}
          value={taskName}
          onChangeText={setTaskName}
          placeholder={namePlaceholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Agent selector — native providers (GUI) + CLI agents (terminal) */}
      <View style={modalStyles.fieldGroup}>
        <Text style={modalStyles.label}>Agent</Text>
        <AgentSelector
          value={agentSelection}
          onChange={setAgentSelection}
          cliAgents={cliAgentsList}
        />
        {agentSelection.mode === "cli" ? (
          <Text style={modalStyles.cliHint}>This agent runs in a terminal window</Text>
        ) : null}
      </View>

      {/* Advanced options toggle */}
      <Pressable style={modalStyles.advancedToggle} onPress={() => setShowAdvanced(!showAdvanced)}>
        <Settings size={16} color={theme.colors.foregroundMuted} />
        <Text style={modalStyles.advancedToggleText}>Advanced options</Text>
        {showAdvanced ? (
          <ChevronUp size={16} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronDown size={16} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>

      {showAdvanced ? (
        <View style={modalStyles.advancedSection}>
          <View style={modalStyles.settingsCard}>
            <Pressable style={modalStyles.checkboxRow} onPress={() => setUseWorktree((v) => !v)}>
              <View style={[modalStyles.checkbox, useWorktree && modalStyles.checkboxChecked]}>
                {useWorktree ? <Check size={12} color={theme.colors.surface0} /> : null}
              </View>
              <Text style={modalStyles.checkboxText}>Local worktree (recommended)</Text>
            </Pressable>

            <Pressable style={modalStyles.checkboxRow} onPress={() => setAutoApprove((v) => !v)}>
              <View style={[modalStyles.checkbox, autoApprove && modalStyles.checkboxChecked]}>
                {autoApprove ? <Check size={12} color={theme.colors.surface0} /> : null}
              </View>
              <Text style={modalStyles.checkboxText}>Skip permissions for file operations</Text>
            </Pressable>
          </View>

          <View style={modalStyles.fieldGroup}>
            <Text style={modalStyles.sectionLabel}>Issue context</Text>
            <View style={modalStyles.integrationsCard}>
              {INTEGRATION_REGISTRY.filter((i) => isIntegrationConnected(i.id)).length > 0 ? (
                INTEGRATION_REGISTRY.filter((i) => isIntegrationConnected(i.id)).map(
                  (integration) => (
                    <IntegrationSelector
                      key={integration.id}
                      integration={integration}
                      isConnected
                      serverId={serverId}
                      cwd={workspacePath}
                      searchSeed={taskName}
                      onSelect={(value) => handleIntegrationChange(integration.id, value)}
                      onSelectItem={(item) => handleIntegrationItemChange(integration.id, item)}
                    />
                  ),
                )
              ) : (
                <Text style={modalStyles.noIntegrationsText}>
                  No integrations connected. Connect in Settings.
                </Text>
              )}
            </View>
          </View>

          <View style={modalStyles.fieldGroup}>
            <Text style={modalStyles.sectionLabel}>Prompt</Text>
            <View style={modalStyles.promptCard}>
              <AdaptiveTextInput
                style={[modalStyles.textInput, modalStyles.textArea]}
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Add extra instructions, or select an issue to preload context..."
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* Create button */}
      <Pressable
        style={({ pressed }) => [
          modalStyles.createButton,
          pressed && modalStyles.createButtonPressed,
          isCreating && modalStyles.createButtonDisabled,
        ]}
        onPress={handleCreate}
        disabled={isCreating}
      >
        <Text style={modalStyles.createButtonText}>{isCreating ? "Creating..." : createLabel}</Text>
      </Pressable>
    </AdaptiveModalSheet>
  );
}

const modalStyles = StyleSheet.create((theme) => ({
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  infoLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  infoSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  fieldGroup: {
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  textInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  textArea: {
    minHeight: 80,
    paddingTop: theme.spacing[2],
  },
  cliHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flex: 1,
  },
  agentBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  advancedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  advancedToggleText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  advancedSection: {
    gap: theme.spacing[4],
    paddingLeft: theme.spacing[1],
  },
  settingsCard: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 2,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  checkboxText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  integrationsCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  noIntegrationsText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    paddingVertical: theme.spacing[2],
  },
  promptCard: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  createButton: {
    backgroundColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing[2],
  },
  createButtonPressed: {
    opacity: 0.8,
  },
  createButtonDisabled: {
    opacity: 0.5,
  },
  createButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.surface1,
  },
}));
