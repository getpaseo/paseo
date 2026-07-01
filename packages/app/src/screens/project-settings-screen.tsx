import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, MoreVertical, Pencil, Plus, X } from "lucide-react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { HostPicker as SharedHostPicker, HostStatusDotSlot } from "@/components/hosts/host-picker";
import type {
  PaseoConfigRaw,
  PaseoConfigRevision,
  ProjectConfigRpcError,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert } from "@/components/ui/alert";
import { ExternalLink } from "@/components/ui/external-link";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useProjects } from "@/hooks/use-projects";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  applyDraftToConfig,
  configToDraft,
  METADATA_PROMPT_KEYS,
  type LifecycleOriginalKind,
  type MetadataPromptKey,
  type ProjectConfigDraft,
  type ProjectScriptDraft,
} from "@/utils/project-config-form";
import { buildProjectsSettingsRoute } from "@/utils/host-routes";
import type { ProjectHostEntry, ProjectSummary } from "@/utils/projects";

const SCRIPT_SERVICE_TYPE = "service";

const ICON_SIZE = 14;

interface MetadataPromptField {
  titleKey: string;
  placeholderKey: string;
  sectionTestID: string;
  inputTestID: string;
}

const METADATA_PROMPT_FIELDS: Record<MetadataPromptKey, MetadataPromptField> = {
  branchName: {
    titleKey: "settings.project.metadata.branchName",
    placeholderKey: "settings.project.metadata.branchNamePlaceholder",
    sectionTestID: "metadata-prompt-branch-name-section",
    inputTestID: "metadata-prompt-branch-name-input",
  },
  commitMessage: {
    titleKey: "settings.project.metadata.commitMessage",
    placeholderKey: "settings.project.metadata.commitMessagePlaceholder",
    sectionTestID: "metadata-prompt-commit-message-section",
    inputTestID: "metadata-prompt-commit-message-input",
  },
  pullRequest: {
    titleKey: "settings.project.metadata.pullRequest",
    placeholderKey: "settings.project.metadata.pullRequestPlaceholder",
    sectionTestID: "metadata-prompt-pull-request-section",
    inputTestID: "metadata-prompt-pull-request-input",
  },
};

const WORKTREE_DOCS_URL = "https://paseo.sh/docs/worktrees";

type ReadProjectConfigData = Awaited<ReturnType<DaemonClient["readProjectConfig"]>>;

export interface ProjectSettingsScreenProps {
  projectKey: string;
}

export default function ProjectSettingsScreen({ projectKey }: ProjectSettingsScreenProps) {
  const { projects } = useProjects();
  const project = useMemo(
    () => projects.find((entry) => entry.projectKey === projectKey),
    [projects, projectKey],
  );
  const editableHosts = useMemo(() => filterEditableHosts(project), [project]);

  const [selectedServerId, setSelectedServerId] = useState<string>(
    () => editableHosts[0]?.serverId ?? "",
  );

  useEffect(() => {
    const stillValid = editableHosts.some((host) => host.serverId === selectedServerId);
    if (!stillValid) {
      setSelectedServerId(editableHosts[0]?.serverId ?? "");
    }
  }, [editableHosts, selectedServerId]);

  const selectedSnapshot = useHostRuntimeSnapshot(selectedServerId);
  const isHostGone =
    Boolean(selectedServerId) &&
    (selectedSnapshot?.connectionStatus === "offline" ||
      selectedSnapshot?.connectionStatus === "error");

  const selectedHost = editableHosts.find((host) => host.serverId === selectedServerId);
  const client = useHostRuntimeClient(selectedHost?.serverId ?? "");

  if (!project || editableHosts.length === 0 || !selectedHost || !client) {
    return <NoEditableTarget />;
  }

  return (
    <ProjectSettingsBody
      project={project}
      hosts={editableHosts}
      selectedHost={selectedHost}
      onSelectHost={setSelectedServerId}
      client={client}
      isHostGone={isHostGone}
    />
  );
}

function filterEditableHosts(project: ProjectSummary | undefined): ProjectHostEntry[] {
  if (!project) return [];
  return project.hosts.filter(
    (host) => host.isOnline && host.serverId.trim().length > 0 && host.repoRoot.trim().length > 0,
  );
}

function navigateBackToProjects() {
  router.navigate(buildProjectsSettingsRoute());
}

function NoEditableTarget() {
  const { t } = useTranslation();
  return (
    <View style={styles.noTargetContainer}>
      <BackToProjectsButton />
      <Text style={styles.noTargetText}>{t("settings.project.noEditableTarget")}</Text>
      <Button
        testID="project-settings-back-button"
        onPress={navigateBackToProjects}
        variant="secondary"
        size="md"
      >
        {t("settings.project.backToProjects")}
      </Button>
    </View>
  );
}

function BackToProjectsButton() {
  const { t } = useTranslation();
  return (
    <Button
      testID="project-settings-back-link"
      accessibilityLabel={t("settings.project.backToProjects")}
      onPress={navigateBackToProjects}
      variant="ghost"
      size="sm"
      leftIcon={ArrowLeft}
      style={styles.backButton}
    >
      {t("settings.project.backToProjects")}
    </Button>
  );
}

interface ProjectSettingsBodyProps {
  project: ProjectSummary;
  hosts: ProjectHostEntry[];
  selectedHost: ProjectHostEntry;
  onSelectHost: (serverId: string) => void;
  client: DaemonClient;
  isHostGone: boolean;
}

function ProjectSettingsBody({
  project,
  hosts,
  selectedHost,
  onSelectHost,
  client,
  isHostGone,
}: ProjectSettingsBodyProps) {
  const queryKey = useMemo(
    () => ["project-config", selectedHost.serverId, selectedHost.repoRoot] as const,
    [selectedHost.serverId, selectedHost.repoRoot],
  );

  const readQuery = useQuery({
    queryKey,
    queryFn: () => client.readProjectConfig(selectedHost.repoRoot),
    retry: false,
  });

  const data = readQuery.data;
  const projectIconTargets = useMemo(
    () => [
      {
        serverId: selectedHost.serverId,
        projectKey: project.projectKey,
        iconWorkingDir: selectedHost.repoRoot,
      },
    ],
    [project.projectKey, selectedHost.repoRoot, selectedHost.serverId],
  );
  const projectIconDataByKey = useProjectIconDataByProjectKey({
    projects: projectIconTargets,
  });
  const projectIconDataUri = projectIconDataByKey.get(project.projectKey) ?? null;
  const loadedConfig: PaseoConfigRaw | null = data?.ok ? (data.config ?? {}) : null;
  const loadedRevision: PaseoConfigRevision | null = data?.ok ? data.revision : null;
  const readError: ProjectConfigRpcError | null = data && !data.ok ? data.error : null;

  const handleReload = useCallback(() => {
    void readQuery.refetch();
  }, [readQuery]);

  const hasMultipleHosts = hosts.length > 1;

  return (
    <View style={styles.body}>
      <BackToProjectsButton />

      <View style={styles.headerBlock}>
        <View style={styles.titleRow}>
          <ProjectTitleIcon
            iconDataUri={projectIconDataUri}
            projectName={project.projectName}
            projectKey={project.projectKey}
          />
          <ProjectNameEditor project={project} client={client} />
        </View>
        <HostContext hosts={hosts} selectedHost={selectedHost} onSelectHost={onSelectHost} />
      </View>

      {renderContent({
        readQuery,
        loadedConfig,
        loadedRevision,
        readError,
        selectedHost,
        queryKey,
        client,
        onReload: handleReload,
        hasMultipleHosts,
        isHostGone,
      })}
    </View>
  );
}

interface RenderContentInput {
  readQuery: ReturnType<typeof useQuery<ReadProjectConfigData>>;
  loadedConfig: PaseoConfigRaw | null;
  loadedRevision: PaseoConfigRevision | null;
  readError: ProjectConfigRpcError | null;
  selectedHost: ProjectHostEntry;
  queryKey: readonly [string, string, string];
  client: DaemonClient;
  onReload: () => void;
  hasMultipleHosts: boolean;
  isHostGone: boolean;
}

function renderContent({
  readQuery,
  loadedConfig,
  loadedRevision,
  readError,
  selectedHost,
  queryKey,
  client,
  onReload,
  hasMultipleHosts,
  isHostGone,
}: RenderContentInput) {
  if (readQuery.isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner color={ResolveSpinnerColor()} />
      </View>
    );
  }

  if (readQuery.isError) {
    return (
      <ReadFailureCallout
        kind="transport"
        error={readQuery.error}
        onReload={onReload}
        hasMultipleHosts={hasMultipleHosts}
      />
    );
  }

  if (readError) {
    return (
      <ReadFailureCallout
        kind={readError.code}
        error={null}
        onReload={onReload}
        hasMultipleHosts={hasMultipleHosts}
      />
    );
  }

  if (isHostGone) {
    return <NoEditableTarget />;
  }

  if (!loadedConfig) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner color={ResolveSpinnerColor()} />
      </View>
    );
  }

  const formKey = `${selectedHost.serverId}::${selectedHost.repoRoot}::${revisionToKey(loadedRevision)}`;
  return (
    <ProjectConfigForm
      key={formKey}
      baseConfig={loadedConfig}
      revision={loadedRevision}
      repoRoot={selectedHost.repoRoot}
      queryKey={queryKey}
      client={client}
      onReload={onReload}
    />
  );
}

function revisionToKey(revision: PaseoConfigRevision | null): string {
  if (!revision) return "none";
  return `${revision.mtimeMs}-${revision.size}`;
}

interface ReadFailureCalloutProps {
  kind: "transport" | ProjectConfigRpcError["code"];
  error: unknown;
  onReload: () => void;
  hasMultipleHosts: boolean;
}

function ReadFailureCallout({ kind, error, onReload, hasMultipleHosts }: ReadFailureCalloutProps) {
  const { t } = useTranslation();
  const { testID, title, description } = resolveReadFailureCopy({
    kind,
    error,
    hasMultipleHosts,
    t,
  });
  return (
    <View style={styles.errorBlock}>
      <Alert testID={testID} variant="error" title={title} description={description}>
        <Button testID={`${testID}-action-0`} onPress={onReload} variant="outline" size="sm">
          {t("settings.project.actions.reload")}
        </Button>
      </Alert>
    </View>
  );
}

function resolveReadFailureCopy(input: {
  kind: ReadFailureCalloutProps["kind"];
  error: unknown;
  hasMultipleHosts: boolean;
  t: TFunction;
}): { testID: string; title: string; description: string } {
  if (input.kind === "invalid_project_config") {
    return {
      testID: "invalid-callout",
      title: input.t("settings.project.readFailures.invalidTitle"),
      description: input.t("settings.project.readFailures.invalidDescription"),
    };
  }
  if (input.kind === "project_not_found") {
    return {
      testID: "project-not-found-callout",
      title: input.t("settings.project.readFailures.missingTitle"),
      description: input.hasMultipleHosts
        ? input.t("settings.project.readFailures.missingWithHosts")
        : input.t("settings.project.readFailures.missingSingleHost"),
    };
  }
  if (input.kind === "transport") {
    const detail = errorToDetail(input.error);
    return {
      testID: "read-transport-callout",
      title: input.t("settings.project.readFailures.transportTitle"),
      description: detail ?? input.t("settings.project.readFailures.transportFallback"),
    };
  }
  return {
    testID: "read-failed-callout",
    title: input.t("settings.project.readFailures.failedTitle"),
    description: input.t("settings.project.readFailures.failedDescription"),
  };
}

function errorToDetail(error: unknown): string | null {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return null;
}

interface ProjectConfigFormProps {
  baseConfig: PaseoConfigRaw;
  revision: PaseoConfigRevision | null;
  repoRoot: string;
  queryKey: readonly [string, string, string];
  client: DaemonClient;
  onReload: () => void;
}

function ProjectConfigForm({
  baseConfig,
  revision,
  repoRoot,
  queryKey,
  client,
  onReload,
}: ProjectConfigFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [draft, setDraft] = useState<ProjectConfigDraft>(() => configToDraft(baseConfig));
  const [writeError, setWriteError] = useState<ProjectConfigRpcError | null>(null);
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (input: {
      config: PaseoConfigRaw;
      expectedRevision: PaseoConfigRevision | null;
    }) => {
      return client.writeProjectConfig({
        repoRoot,
        config: input.config,
        expectedRevision: input.expectedRevision,
      });
    },
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.setQueryData<ReadProjectConfigData>(queryKey, {
          ok: true,
          config: result.config,
          revision: result.revision,
          requestId: "local-cache",
          repoRoot,
        });
        setWriteError(null);
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        toast.show(t("settings.project.actions.saved"), { variant: "success" });
      } else {
        setWriteError(result.error);
      }
    },
  });

  const handleSave = useCallback(() => {
    if (writeError?.code === "stale_project_config") return;
    const config = applyDraftToConfig({ draft, base: baseConfig });
    saveMutation.mutate({ config, expectedRevision: revision });
  }, [draft, baseConfig, revision, writeError, saveMutation]);

  const handleReload = useCallback(() => {
    setWriteError(null);
    onReload();
  }, [onReload]);

  const updateDraft = useCallback((updater: (draft: ProjectConfigDraft) => ProjectConfigDraft) => {
    setDraft((prev) => updater(prev));
  }, []);

  const handleSetupChange = useCallback(
    (text: string) => updateDraft((d) => ({ ...d, setupText: text })),
    [updateDraft],
  );
  const handleTeardownChange = useCallback(
    (text: string) => updateDraft((d) => ({ ...d, teardownText: text })),
    [updateDraft],
  );

  const handleMetadataPromptChange = useCallback(
    (key: MetadataPromptKey, text: string) =>
      updateDraft((d) => ({
        ...d,
        metadataPrompts: { ...d.metadataPrompts, [key]: text },
      })),
    [updateDraft],
  );

  const handleRemoveScript = useCallback(
    async (script: ProjectScriptDraft) => {
      const ok = await confirmDialog({
        title: t("settings.project.scripts.removeTitle"),
        message: t("settings.project.scripts.removeMessage", {
          name: script.name || t("settings.project.scripts.removeFallbackName"),
        }),
        confirmLabel: t("settings.project.scripts.actions.remove"),
        cancelLabel: t("settings.project.actions.cancel"),
        destructive: true,
      });
      if (!ok) return;
      updateDraft((d) => ({
        ...d,
        scripts: d.scripts.filter((entry) => entry.id !== script.id),
      }));
    },
    [t, updateDraft],
  );

  const handleEditScript = useCallback((script: ProjectScriptDraft) => {
    setEditingScriptId(script.id);
  }, []);

  const handleAddScript = useCallback(() => {
    const id = `script-draft-new-${Date.now()}`;
    updateDraft((d) => ({
      ...d,
      scripts: [
        ...d.scripts,
        {
          id,
          name: "",
          commandText: "",
          commandOriginalKind: "missing" satisfies LifecycleOriginalKind,
          type: "",
          portText: "",
          rawEntry: {},
        },
      ],
    }));
    setEditingScriptId(id);
  }, [updateDraft]);

  const handleEditingDraftChange = useCallback(
    (next: ProjectScriptDraft) => {
      updateDraft((d) => ({
        ...d,
        scripts: d.scripts.map((entry) => (entry.id === next.id ? next : entry)),
      }));
    },
    [updateDraft],
  );

  const handleCancelEditing = useCallback(() => {
    if (!editingScriptId) {
      return;
    }
    updateDraft((d) => {
      const entry = d.scripts.find((row) => row.id === editingScriptId);
      if (!entry) return d;
      const isEmpty =
        entry.name.trim().length === 0 &&
        entry.commandText.trim().length === 0 &&
        entry.type.trim().length === 0 &&
        entry.portText.trim().length === 0;
      if (!isEmpty) return d;
      return { ...d, scripts: d.scripts.filter((row) => row.id !== editingScriptId) };
    });
    setEditingScriptId(null);
  }, [editingScriptId, updateDraft]);

  const handleSaveEditing = useCallback(() => {
    setEditingScriptId(null);
  }, []);

  const editingScript = draft.scripts.find((entry) => entry.id === editingScriptId);

  const hasInvalidScripts = useMemo(
    () => draft.scripts.some((script) => validateScript(script, t).hasErrors),
    [draft.scripts, t],
  );

  const scriptsTrailing = useMemo(
    () => (
      <Pressable
        onPress={handleAddScript}
        hitSlop={8}
        style={settingsStyles.sectionHeaderLink}
        accessibilityRole="button"
        accessibilityLabel={t("settings.project.scripts.actions.add")}
        testID="scripts-add-button"
      >
        <Plus size={ICON_SIZE} color={styles.iconColor.color} />
      </Pressable>
    ),
    [handleAddScript, t],
  );

  const setupDocsLink = useMemo(
    () => (
      <ExternalLink
        href={WORKTREE_DOCS_URL}
        label={t("settings.project.worktree.docs")}
        tooltip={t("settings.project.worktree.docsTooltip")}
        testID="worktree-setup-docs-link"
      />
    ),
    [t],
  );
  const teardownDocsLink = useMemo(
    () => (
      <ExternalLink
        href={WORKTREE_DOCS_URL}
        label={t("settings.project.worktree.docs")}
        tooltip={t("settings.project.worktree.docsTooltip")}
        testID="worktree-teardown-docs-link"
      />
    ),
    [t],
  );

  const isStale = writeError?.code === "stale_project_config";
  const isWriteFailed = writeError?.code === "write_failed";
  const saveDisabled = saveMutation.isPending || isStale || hasInvalidScripts;

  return (
    <View>
      <SettingsGroup
        title={t("settings.project.worktree.title")}
        info={t("settings.project.worktree.info")}
        testID="worktree-group"
      >
        <SettingsSection
          title={t("settings.project.worktree.setup")}
          testID="worktree-setup-section"
          trailing={setupDocsLink}
        >
          <SettingsTextAreaCard
            testID="worktree-setup-input"
            accessibilityLabel={t("settings.project.worktree.setupAccessibility")}
            value={draft.setupText}
            onChangeText={handleSetupChange}
            placeholder="npm install"
          />
        </SettingsSection>

        <SettingsSection
          title={t("settings.project.worktree.teardown")}
          testID="worktree-teardown-section"
          trailing={teardownDocsLink}
          flush
        >
          <SettingsTextAreaCard
            testID="worktree-teardown-input"
            accessibilityLabel={t("settings.project.worktree.teardownAccessibility")}
            value={draft.teardownText}
            onChangeText={handleTeardownChange}
            placeholder="docker compose down"
          />
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.project.scripts.title")}
        info={t("settings.project.scripts.info")}
        trailing={scriptsTrailing}
        testID="scripts-group"
      >
        <View style={settingsStyles.card} testID="scripts-list">
          {draft.scripts.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={styles.emptyScripts}>{t("settings.project.scripts.empty")}</Text>
            </View>
          ) : (
            draft.scripts.map((script, index) => (
              <ScriptRow
                key={script.id}
                script={script}
                isFirst={index === 0}
                onEdit={handleEditScript}
                onRemove={handleRemoveScript}
              />
            ))
          )}
        </View>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.project.metadata.title")}
        info={t("settings.project.metadata.info")}
        testID="metadata-group"
      >
        {METADATA_PROMPT_KEYS.map((key, index) => (
          <MetadataPromptSection
            key={key}
            promptKey={key}
            value={draft.metadataPrompts[key]}
            onChange={handleMetadataPromptChange}
            flush={index === METADATA_PROMPT_KEYS.length - 1}
          />
        ))}
      </SettingsGroup>

      {isStale ? (
        <View style={styles.calloutWrap}>
          <Alert
            testID="stale-callout"
            variant="error"
            title={t("settings.project.writeFailures.staleTitle")}
            description={t("settings.project.writeFailures.staleDescription")}
          >
            <Button
              testID="stale-callout-action-0"
              onPress={handleReload}
              variant="outline"
              size="sm"
            >
              {t("settings.project.actions.reload")}
            </Button>
          </Alert>
        </View>
      ) : null}

      {isWriteFailed ? (
        <View style={styles.calloutWrap}>
          <Alert
            testID="write-failed-callout"
            variant="error"
            title={t("settings.project.writeFailures.failedTitle")}
            description={t("settings.project.writeFailures.failedDescription")}
          >
            <Button
              testID="write-failed-callout-action-0"
              onPress={handleSave}
              variant="outline"
              size="sm"
            >
              {t("settings.project.actions.tryAgain")}
            </Button>
            <Button
              testID="write-failed-callout-action-1"
              onPress={handleReload}
              variant="outline"
              size="sm"
            >
              {t("settings.project.actions.reload")}
            </Button>
          </Alert>
        </View>
      ) : null}

      <View style={styles.footer}>
        <Button
          testID="save-button"
          accessibilityLabel={t("settings.project.actions.save")}
          variant="default"
          size="md"
          disabled={saveDisabled}
          loading={saveMutation.isPending}
          onPress={handleSave}
        >
          {saveMutation.isPending
            ? t("settings.project.actions.saving")
            : t("settings.project.actions.save")}
        </Button>
      </View>

      {editingScript ? (
        <ScriptEditModal
          script={editingScript}
          onChange={handleEditingDraftChange}
          onCancel={handleCancelEditing}
          onSave={handleSaveEditing}
        />
      ) : null}
    </View>
  );
}

function ResolveSpinnerColor(): string {
  return styles.spinnerColor.color;
}

interface ProjectNameEditorProps {
  project: ProjectSummary;
  client: DaemonClient;
}

function ProjectNameEditor({ project, client }: ProjectNameEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(project.projectCustomName ?? "");

  const renameMutation = useMutation({
    mutationFn: (customName: string | null) => client.renameProject(project.projectKey, customName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setIsEditing(false);
      toast.show(t("settings.project.rename.renamedToast"), { variant: "success" });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : t("settings.project.rename.errorFallback");
      toast.show(message, { variant: "error" });
    },
  });

  const handleStartEdit = useCallback(() => {
    setValue(project.projectCustomName ?? "");
    setIsEditing(true);
  }, [project.projectCustomName]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setValue(project.projectCustomName ?? "");
  }, [project.projectCustomName]);

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === (project.projectCustomName ?? null)) {
      setIsEditing(false);
      return;
    }
    renameMutation.mutate(next);
  }, [value, project.projectCustomName, renameMutation]);

  const handleReset = useCallback(() => {
    renameMutation.mutate(null);
  }, [renameMutation]);

  if (!isEditing) {
    return (
      <View style={styles.nameEditorRow}>
        <Text style={styles.projectTitle} numberOfLines={1}>
          {project.projectName}
        </Text>
        <Pressable
          testID="project-name-edit-button"
          accessibilityLabel={t("settings.project.rename.renameLabel")}
          onPress={handleStartEdit}
          hitSlop={8}
          style={styles.nameEditorIconButton}
        >
          <Pencil size={ICON_SIZE} color={styles.iconColor.color} />
        </Pressable>
        {project.projectCustomName ? (
          <Pressable
            testID="project-name-reset-button"
            accessibilityLabel={t("settings.project.rename.resetLabel")}
            onPress={handleReset}
            disabled={renameMutation.isPending}
            hitSlop={8}
            style={styles.nameEditorResetButton}
          >
            <Text style={styles.nameEditorResetText}>{t("settings.project.rename.reset")}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.nameEditorRow}>
      <TextInput
        testID="project-name-input"
        accessibilityLabel={t("settings.project.rename.projectNameLabel")}
        value={value}
        onChangeText={setValue}
        placeholder={project.projectName}
        placeholderTextColor={styles.placeholderColor.color}
        autoFocus
        style={styles.nameEditorInput}
        editable={!renameMutation.isPending}
        onSubmitEditing={handleSave}
        returnKeyType="done"
      />
      <Pressable
        testID="project-name-save-button"
        accessibilityLabel={t("settings.project.rename.saveLabel")}
        onPress={handleSave}
        disabled={renameMutation.isPending}
        hitSlop={8}
        style={styles.nameEditorIconButton}
      >
        <Check size={ICON_SIZE} color={styles.iconColor.color} />
      </Pressable>
      <Pressable
        testID="project-name-cancel-button"
        accessibilityLabel={t("settings.project.rename.cancelLabel")}
        onPress={handleCancel}
        disabled={renameMutation.isPending}
        hitSlop={8}
        style={styles.nameEditorIconButton}
      >
        <X size={ICON_SIZE} color={styles.iconColor.color} />
      </Pressable>
    </View>
  );
}

function ProjectTitleIcon({
  iconDataUri,
  projectName,
  projectKey,
}: {
  iconDataUri: string | null;
  projectName: string;
  projectKey: string;
}) {
  const initial = projectName.trim().charAt(0).toUpperCase() || "?";
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={initial}
      projectKey={projectKey}
      imageStyle={styles.titleIcon}
      fallbackStyle={styles.titleIconFallback}
      textStyle={styles.titleIconFallbackText}
    />
  );
}

interface HostContextProps {
  hosts: ProjectHostEntry[];
  selectedHost: ProjectHostEntry;
  onSelectHost: (serverId: string) => void;
}

function HostContext({ hosts, selectedHost, onSelectHost }: HostContextProps) {
  if (hosts.length > 1) {
    return <HostPicker hosts={hosts} selectedHost={selectedHost} onSelectHost={onSelectHost} />;
  }
  return (
    <View testID="host-indicator" style={styles.hostIndicator}>
      <HostStatusDotSlot serverId={selectedHost.serverId} />
      <Text style={styles.hostName} numberOfLines={1}>
        {selectedHost.serverName}
      </Text>
    </View>
  );
}

interface HostPickerProps {
  hosts: ProjectHostEntry[];
  selectedHost: ProjectHostEntry;
  onSelectHost: (serverId: string) => void;
}

function HostPicker({ hosts, selectedHost, onSelectHost }: HostPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const hostOptions = useMemo(
    () => hosts.map((host) => ({ serverId: host.serverId, label: host.serverName })),
    [hosts],
  );
  const handleOpen = useCallback(() => setOpen(true), []);
  const hostOptionTestID = useCallback((serverId: string) => `host-picker-item-${serverId}`, []);
  return (
    <SharedHostPicker
      hosts={hostOptions}
      value={selectedHost.serverId}
      onSelect={onSelectHost}
      open={open}
      onOpenChange={setOpen}
      anchorRef={triggerRef}
      searchable={false}
      title={t("settings.project.switchHost")}
      desktopPlacement="bottom-start"
      desktopMinWidth={240}
      hostOptionTestID={hostOptionTestID}
    >
      <Pressable
        ref={triggerRef}
        accessibilityLabel={t("settings.project.switchHost")}
        testID="host-picker"
        style={styles.hostIndicator}
        onPress={handleOpen}
      >
        <HostStatusDotSlot serverId={selectedHost.serverId} />
        <Text style={styles.hostName} numberOfLines={1}>
          {selectedHost.serverName}
        </Text>
        <ChevronDown size={ICON_SIZE} color={styles.chevronColor.color} />
      </Pressable>
    </SharedHostPicker>
  );
}

interface MetadataPromptSectionProps {
  promptKey: MetadataPromptKey;
  value: string;
  onChange: (key: MetadataPromptKey, text: string) => void;
  flush?: boolean;
}

function MetadataPromptSection({ promptKey, value, onChange, flush }: MetadataPromptSectionProps) {
  const { t } = useTranslation();
  const meta = METADATA_PROMPT_FIELDS[promptKey];
  const title = t(meta.titleKey);
  const handleChange = useCallback(
    (text: string) => onChange(promptKey, text),
    [onChange, promptKey],
  );
  return (
    <SettingsSection title={title} testID={meta.sectionTestID} flush={flush}>
      <SettingsTextAreaCard
        testID={meta.inputTestID}
        accessibilityLabel={title}
        value={value}
        onChangeText={handleChange}
        placeholder={t(meta.placeholderKey)}
      />
    </SettingsSection>
  );
}

interface ScriptRowProps {
  script: ProjectScriptDraft;
  isFirst: boolean;
  onEdit: (script: ProjectScriptDraft) => void;
  onRemove: (script: ProjectScriptDraft) => void;
}

function ScriptRow({ script, isFirst, onEdit, onRemove }: ScriptRowProps) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(script), [onEdit, script]);
  const handleRemove = useCallback(() => onRemove(script), [onRemove, script]);
  const rowStyle = isFirst ? styles.scriptRow : styles.scriptRowWithBorder;

  return (
    <View style={rowStyle} testID={`script-row-${script.id}`}>
      <Pressable style={styles.scriptRowMain} onPress={handleEdit}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {script.name || t("settings.project.scripts.untitled")}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {scriptHint(script, t)}
        </Text>
      </Pressable>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityLabel={t("settings.project.scripts.menuAccessibility")}
          testID={`script-row-menu-${script.id}`}
          style={styles.scriptKebab}
        >
          <MoreVertical size={ICON_SIZE} color={styles.chevronColor.color} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={160}>
          <DropdownMenuItem testID={`script-action-${script.id}-edit`} onSelect={handleEdit}>
            {t("settings.project.scripts.actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            testID={`script-action-${script.id}-remove`}
            destructive
            onSelect={handleRemove}
          >
            {t("settings.project.scripts.actions.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function scriptHint(script: ProjectScriptDraft, t: TFunction): string {
  const pieces: string[] = [];
  if (script.type) pieces.push(script.type);
  if (script.portText) pieces.push(t("settings.project.scripts.port", { port: script.portText }));
  if (script.commandText) pieces.push(script.commandText.split("\n")[0] ?? "");
  return pieces.join(" · ");
}

interface ScriptValidation {
  hasErrors: boolean;
  nameError: string | null;
  commandError: string | null;
}

function validateScript(script: ProjectScriptDraft, t: TFunction): ScriptValidation {
  const nameError =
    script.name.trim().length === 0 ? t("settings.project.scripts.nameRequired") : null;
  const commandError =
    script.commandText.trim().length === 0 ? t("settings.project.scripts.commandRequired") : null;
  return {
    hasErrors: Boolean(nameError || commandError),
    nameError,
    commandError,
  };
}

interface ScriptEditModalProps {
  script: ProjectScriptDraft;
  onChange: (next: ProjectScriptDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

interface ScriptFieldsTouched {
  name: boolean;
  command: boolean;
}

const ALL_TOUCHED: ScriptFieldsTouched = { name: true, command: true };
const NONE_TOUCHED: ScriptFieldsTouched = { name: false, command: false };

function ScriptEditModal({ script, onChange, onCancel, onSave }: ScriptEditModalProps) {
  const { t } = useTranslation();
  const [touched, setTouched] = useState<ScriptFieldsTouched>(NONE_TOUCHED);

  useEffect(() => {
    setTouched(NONE_TOUCHED);
  }, [script.id]);

  const markTouched = useCallback((field: keyof ScriptFieldsTouched) => {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }, []);

  const handleNameChange = useCallback(
    (text: string) => onChange({ ...script, name: text }),
    [onChange, script],
  );
  const handleCommandChange = useCallback(
    (text: string) => onChange({ ...script, commandText: text }),
    [onChange, script],
  );
  const handleServiceToggle = useCallback(
    (next: boolean) => onChange({ ...script, type: next ? SCRIPT_SERVICE_TYPE : "" }),
    [onChange, script],
  );

  const handleNameBlur = useCallback(() => markTouched("name"), [markTouched]);
  const handleCommandBlur = useCallback(() => markTouched("command"), [markTouched]);

  const validation = validateScript(script, t);

  const handleSavePress = useCallback(() => {
    if (validation.hasErrors) {
      setTouched(ALL_TOUCHED);
      return;
    }
    onSave();
  }, [validation.hasErrors, onSave]);

  const showNameError = touched.name && validation.nameError;
  const showCommandError = touched.command && validation.commandError;
  const isService = script.type === SCRIPT_SERVICE_TYPE;
  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: script.name
        ? t("settings.project.scripts.editScript", { name: script.name })
        : t("settings.project.scripts.newScript"),
    }),
    [script.name, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={sheetHeader}
      onClose={onCancel}
      testID="script-edit-modal"
      desktopMaxWidth={560}
    >
      <View style={styles.modalSection}>
        <Text style={styles.modalLabel}>{t("settings.project.scripts.name")}</Text>
        <TextInput
          testID="script-edit-name"
          accessibilityLabel={t("settings.project.scripts.nameAccessibility")}
          value={script.name}
          onChangeText={handleNameChange}
          onBlur={handleNameBlur}
          placeholder="dev"
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.modalInput}
        />
        {showNameError ? (
          <Text testID="script-edit-name-error" style={styles.fieldError}>
            {validation.nameError}
          </Text>
        ) : null}
      </View>
      <View style={styles.modalSection}>
        <Text style={styles.modalLabel}>{t("settings.project.scripts.command")}</Text>
        <TextInput
          testID="script-edit-command"
          accessibilityLabel={t("settings.project.scripts.commandAccessibility")}
          multiline
          value={script.commandText}
          onChangeText={handleCommandChange}
          onBlur={handleCommandBlur}
          placeholder="npm run dev"
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.modalMultilineInput}
        />
        {showCommandError ? (
          <Text testID="script-edit-command-error" style={styles.fieldError}>
            {validation.commandError}
          </Text>
        ) : null}
      </View>
      <View style={styles.modalSection}>
        <View style={styles.serviceToggleRow}>
          <View style={styles.serviceToggleText}>
            <Text style={styles.serviceToggleLabel}>
              {t("settings.project.scripts.runAsService")}
            </Text>
            <Text style={styles.modalHint}>{t("settings.project.scripts.serviceHint")}</Text>
          </View>
          <Switch
            value={isService}
            onValueChange={handleServiceToggle}
            accessibilityLabel={t("settings.project.scripts.runAsService")}
            testID="script-edit-service-toggle"
          />
        </View>
      </View>
      <View style={styles.modalFooter}>
        <Button onPress={onCancel} variant="ghost" size="md" testID="script-edit-cancel">
          {t("settings.project.actions.cancel")}
        </Button>
        <Button onPress={handleSavePress} variant="default" size="md" testID="script-edit-save">
          {t("settings.project.actions.save")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  noTargetContainer: {
    padding: theme.spacing[4],
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  noTargetText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  backButton: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
  },
  headerBlock: {
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  nameEditorRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  nameEditorIconButton: {
    padding: theme.spacing[1],
  },
  nameEditorInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    minWidth: 0,
  },
  nameEditorResetButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  nameEditorResetText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  titleIcon: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  titleIconFallback: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  titleIconFallbackText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  hostIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    alignSelf: "flex-start",
    minWidth: 0,
  },
  hostName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  errorBlock: {
    marginTop: theme.spacing[2],
  },
  emptyScripts: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  scriptRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  scriptRowWithBorder: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  scriptRowMain: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  scriptKebab: {
    padding: theme.spacing[1],
  },
  calloutWrap: {
    marginTop: theme.spacing[3],
  },
  footer: {
    marginTop: theme.spacing[4],
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  modalSection: {
    gap: theme.spacing[2],
  },
  modalLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  modalInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  modalMultilineInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    minHeight: 100,
    textAlignVertical: "top",
  },
  modalFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  fieldError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  serviceToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  serviceToggleText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  serviceToggleLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  modalHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  chevronColor: {
    color: theme.colors.foregroundMuted,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));
