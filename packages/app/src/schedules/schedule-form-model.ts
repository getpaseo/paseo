import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { ScheduleCadence, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels, findModelByReference } from "@/provider-selection/model-catalog";
import {
  buildProviderDefinitionMapForStatuses,
  INITIAL_USER_MODIFIED,
  RESOLVABLE_PROVIDER_STATUSES,
  resolveDefaultModelId,
  resolveFormStateFromProviderModels,
  resolveThinkingOptionId,
  type FormInitialValues,
  type FormState,
  type ProviderModelsByProvider,
  type UserModifiedFields,
} from "@/provider-selection/resolve-agent-form";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { shortenPath } from "@/utils/shorten-path";
import { normalizeScheduleFormCadence } from "./schedule-cadence-options";
import {
  canJudgeWorkspaceMissing,
  PROJECT_OPTION_PREFIX,
  type ScheduleProjectTarget,
  type ScheduleProjectWorkspace,
} from "./schedule-project-targets";

export interface ScheduleFormDisplay {
  label: string;
  description?: string;
}

export interface ScheduleFormHost {
  serverId: string;
  label: string;
  supportsWorkspaceMultiplicity?: boolean;
  supportsWorkspaceTarget?: boolean;
  /** The host's workspace list has loaded, so a missing workspace is really gone. */
  workspacesLoaded?: boolean;
  /** The host's connection is online. An offline host keeps a stale list, so nothing is gone. */
  isOnline?: boolean;
}

export interface ScheduleFormSnapshot {
  mode: "create" | "edit";
  schedule?: ScheduleSummary & { serverId?: string; serverName?: string };
  hosts: readonly ScheduleFormHost[];
  defaults: {
    serverId?: string | null;
    projectTargets: readonly ScheduleProjectTarget[];
    preferences?: FormPreferences;
    timezone?: string;
  };
}

export interface ScheduleFormProviderSnapshot {
  entries: ProviderSnapshotEntry[];
}

export interface ScheduleDisclosureState {
  showProjectField: boolean;
  showModelField: boolean;
  showThinkingField: boolean;
  showModeField: boolean;
  showWorkspaceField: boolean;
  showIsolationField: boolean;
  showArchiveOnFinishField: boolean;
}

export interface ScheduleProviderSnapshotRequest {
  serverId: string;
  cwd: string;
}

export interface ScheduleFormProjectOption {
  id: string;
  value: string;
  label: string;
  testID: string;
}

export interface ScheduleFormWorkspaceOption {
  id: string;
  value: string;
  label: string;
  /** Null for the "new workspace each run" option. */
  workspaceKind: ScheduleProjectWorkspace["workspaceKind"] | null;
  testID: string;
}

export const NEW_WORKSPACE_OPTION_ID = "new-workspace";
const NEW_WORKSPACE_LABEL = "New workspace each run";
const WORKSPACE_UNAVAILABLE_LABEL = "Workspace unavailable";
export const WORKSPACE_UNAVAILABLE_ERROR = "Choose another workspace";

export type ScheduleFormTargetKind = "agent" | "new-agent";
type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;
type ProviderResolutionStatus = "idle" | "pending" | "complete";

export interface ScheduleFormState {
  mode: "create" | "edit";
  /** The schedule being edited has already ended, so editing cannot bring its runs back. */
  scheduleCompleted: boolean;
  targetKind: ScheduleFormTargetKind;
  name: string;
  prompt: string;
  maxRuns: string;
  cadence: ScheduleCadence;
  submitCadence: CronCadence | undefined;
  hosts: ScheduleFormHost[];
  projectOptions: ScheduleFormProjectOption[];
  selectedServerId: string | null;
  selectedProvider: AgentProvider | null;
  selectedModel: string;
  selectedMode: string;
  selectedThinkingOptionId: string;
  workingDir: string;
  projectDisplay: ScheduleFormDisplay | null;
  selectedProjectOptionId: string;
  selectedModelDisplay: ScheduleFormDisplay | null;
  selectedModeDisplay: ScheduleFormDisplay;
  selectedThinkingDisplay: ScheduleFormDisplay | null;
  modelSelectorProviders: ProviderSelectorProvider[];
  modeOptions: AgentMode[];
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  archiveOnFinish: boolean;
  isolation: "local" | "worktree";
  effectiveIsolation: "local" | "worktree";
  /** The workspace every run goes into; null creates a workspace per run. */
  selectedWorkspaceId: string | null;
  workspaceOptions: ScheduleFormWorkspaceOption[];
  selectedWorkspaceDisplay: ScheduleFormDisplay;
  workspaceLoading: boolean;
  workspaceError: string | null;
  /** String binds, null clears a binding (edit only), undefined leaves it alone. */
  submitWorkspaceId: string | null | undefined;
  submitArchiveOnFinish: boolean | undefined;
  submitIsolation: "local" | "worktree" | undefined;
  canUseWorktreeIsolation: boolean;
  providerResolutionByServerId: Record<string, ProviderResolutionStatus>;
  providerSnapshotRequest: ScheduleProviderSnapshotRequest | null;
  disclosure: ScheduleDisclosureState;
  canSubmit: boolean;
  submitError: string | null;
}

export interface ScheduleFormModel {
  getState: () => ScheduleFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly ScheduleFormHost[]) => void;
  applyProjectTargets: (targets: readonly ScheduleProjectTarget[]) => void;
  applyPreferences: (preferences: FormPreferences | undefined) => void;
  applyProviderSnapshot: (serverId: string, snapshot: ScheduleFormProviderSnapshot) => void;
  setHost: (serverId: string | null) => void;
  setProject: (optionId: string, display: ScheduleFormDisplay) => void;
  setWorkspace: (workspaceId: string | null) => void;
  setModel: (provider: AgentProvider, modelId: string) => void;
  setThinking: (thinkingOptionId: string) => void;
  setSessionMode: (modeId: string) => void;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setMaxRuns: (value: string) => void;
  setCadence: (value: ScheduleCadence) => void;
  setIsolation: (value: "local" | "worktree") => void;
  setArchiveOnFinish: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

const DEFAULT_CADENCE: ScheduleCadence = { type: "every", everyMs: 60 * 60 * 1000 };
const DEFAULT_TIMEZONE = "UTC";

type ThinkingOption = NonNullable<AgentModelDefinition["thinkingOptions"]>[number];

function newAgentConfig(schedule: ScheduleFormSnapshot["schedule"]) {
  if (schedule?.target.type === "new-agent") {
    return schedule.target.config;
  }
  return null;
}

function buildProjectOptionTestId(optionId: string): string {
  const targetKey = optionId.slice(PROJECT_OPTION_PREFIX.length).replace(/^[^:]+:/, "");
  return `schedule-project-option-${targetKey}`;
}

function buildProjectDisplay(target: ScheduleProjectTarget): ScheduleFormDisplay {
  return { label: target.projectName };
}

function buildStoredProjectDisplay(cwd: string): ScheduleFormDisplay | null {
  const storedPath = cwd.trim();
  if (!storedPath) {
    return null;
  }
  return { label: shortenPath(storedPath) };
}

function buildProjectOptions(
  targets: readonly ScheduleProjectTarget[],
  serverId: string | null,
): ScheduleFormProjectOption[] {
  if (!serverId) {
    return [];
  }
  return targets
    .filter((target) => target.serverId === serverId)
    .map((target) => ({
      id: target.optionId,
      value: target.optionId,
      label: target.projectName,
      testID: buildProjectOptionTestId(target.optionId),
    }));
}

function resolveProjectTarget(input: {
  targets: readonly ScheduleProjectTarget[];
  serverId: string | null;
  cwd: string;
  workspaceId?: string | null;
}): ScheduleProjectTarget | null {
  const cwd = input.cwd.trim();
  if (!input.serverId || !cwd) {
    return null;
  }
  // A schedule bound to a workspace stores that workspace's directory, which is not always
  // its project root (a worktree), so the workspace names the project.
  const workspaceId = input.workspaceId;
  const targetOfWorkspace = workspaceId
    ? input.targets.find(
        (target) =>
          target.serverId === input.serverId &&
          target.workspaces.some((workspace) => workspace.id === workspaceId),
      )
    : undefined;
  return (
    targetOfWorkspace ??
    input.targets.find((target) => target.serverId === input.serverId && target.cwd === cwd) ??
    null
  );
}

function findProjectTargetByOptionId(
  targets: readonly ScheduleProjectTarget[],
  optionId: string,
): ScheduleProjectTarget | null {
  return targets.find((target) => target.optionId === optionId) ?? null;
}

function resolveProjectDisplay(input: {
  targets: readonly ScheduleProjectTarget[];
  serverId: string | null;
  cwd: string;
  workspaceId?: string | null;
}): ScheduleFormDisplay | null {
  const target = resolveProjectTarget(input);
  if (target) {
    return buildProjectDisplay(target);
  }
  // A bound schedule stores its workspace's directory, which names no project once the
  // workspace is gone, so the field stays on its placeholder instead of showing a path
  // while nothing is selected.
  if (input.workspaceId) {
    return null;
  }
  return buildStoredProjectDisplay(input.cwd);
}

function buildProviderModelsByProvider(entries: ProviderSnapshotEntry[]): ProviderModelsByProvider {
  const map: ProviderModelsByProvider = new Map();
  for (const entry of entries) {
    map.set(entry.provider, filterSelectableModels(entry.models ?? null));
  }
  return map;
}

function resolveSelectedEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): ProviderSnapshotEntry | null {
  if (!provider) {
    return null;
  }
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function resolveModeOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentMode[] {
  return resolveSelectedEntry(entries, provider)?.modes ?? [];
}

function resolveAvailableModels(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
): AgentModelDefinition[] | null {
  return filterSelectableModels(resolveSelectedEntry(entries, provider)?.models ?? null);
}

function resolveEffectiveModel(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  const selectedModelId = modelId.trim();
  if (!models || !selectedModelId) {
    return null;
  }
  return (
    models.find((model) => model.id === selectedModelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
  );
}

function resolveThinkingOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: AgentProvider | null,
  modelId: string,
): NonNullable<AgentModelDefinition["thinkingOptions"]> {
  const model = resolveEffectiveModel(resolveAvailableModels(entries, provider), modelId);
  return model?.thinkingOptions ?? [];
}

function resolveModelDisplay(input: {
  entries: readonly ProviderSnapshotEntry[];
  provider: AgentProvider | null;
  modelId: string;
}): ScheduleFormDisplay | null {
  const modelId = input.modelId.trim();
  if (!modelId) {
    return null;
  }
  const model = resolveEffectiveModel(
    resolveAvailableModels(input.entries, input.provider),
    modelId,
  );
  return { label: model?.label ?? modelId };
}

function resolveModeDisplay(input: {
  modeOptions: readonly AgentMode[];
  modeId: string;
}): ScheduleFormDisplay {
  const modeId = input.modeId.trim();
  if (!modeId) {
    return { label: "Default mode" };
  }
  return { label: input.modeOptions.find((mode) => mode.id === modeId)?.label ?? modeId };
}

function resolveThinkingDisplay(input: {
  options: readonly ThinkingOption[];
  thinkingOptionId: string;
}): ScheduleFormDisplay | null {
  const thinkingOptionId = input.thinkingOptionId.trim();
  if (!thinkingOptionId) {
    return null;
  }
  const option = input.options.find((entry) => entry.id === thinkingOptionId) ?? {
    id: thinkingOptionId,
  };
  return { label: formatThinkingOptionLabel(option) };
}

function isSelectedModelValidForProviders(input: {
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: AgentProvider | null;
  selectedModel: string;
}): boolean {
  if (!input.selectedProvider) {
    return false;
  }
  const provider = input.providers.find((entry) => entry.id === input.selectedProvider);
  if (!provider || provider.modelSelection.kind !== "models") {
    return false;
  }
  const selectedModel = input.selectedModel.trim();
  if (!selectedModel) {
    return true;
  }
  return provider.modelSelection.rows.some((row) => row.modelId === selectedModel);
}

function normalizeInitialValues(input: {
  snapshot: ScheduleFormSnapshot;
}): FormInitialValues | undefined {
  const config = newAgentConfig(input.snapshot.schedule);
  if (!config) {
    return undefined;
  }
  return {
    provider: config.provider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
  };
}

function resolveInitialServerId(snapshot: ScheduleFormSnapshot): string | null {
  if (snapshot.mode === "edit") {
    return snapshot.schedule?.serverId ?? snapshot.defaults.serverId ?? null;
  }
  if (snapshot.defaults.serverId !== undefined) {
    return snapshot.defaults.serverId;
  }
  if (snapshot.hosts.length === 1) {
    return snapshot.hosts[0]?.serverId ?? null;
  }
  return null;
}

function makeProviderResolutionRecord(
  serverId: string | null,
): Record<string, ProviderResolutionStatus> {
  if (!serverId) {
    return {};
  }
  return { [serverId]: "pending" };
}

function resolveTargetKind(snapshot: ScheduleFormSnapshot): ScheduleFormTargetKind {
  if (snapshot.mode === "edit" && snapshot.schedule?.target.type === "agent") {
    return "agent";
  }
  return "new-agent";
}

function buildProviderSnapshotRequest(input: {
  targetKind: ScheduleFormTargetKind;
  selectedServerId: string | null;
  workingDir: string;
}): ScheduleProviderSnapshotRequest | null {
  if (input.targetKind !== "new-agent" || !input.selectedServerId || !input.workingDir.trim()) {
    return null;
  }
  return { serverId: input.selectedServerId, cwd: input.workingDir };
}

function buildInitialProjectDisplay(input: {
  config: ReturnType<typeof newAgentConfig>;
  targets: readonly ScheduleProjectTarget[];
  selectedServerId: string | null;
}): ScheduleFormDisplay | null {
  if (!input.config) {
    return null;
  }
  return resolveProjectDisplay({
    targets: input.targets,
    serverId: input.selectedServerId,
    cwd: input.config.cwd,
    workspaceId: input.config.workspaceId,
  });
}

function buildInitialModelDisplay(modelId: string): ScheduleFormDisplay | null {
  if (!modelId) {
    return null;
  }
  return { label: modelId };
}

function buildInitialModeDisplay(modeId: string): ScheduleFormDisplay {
  if (!modeId) {
    return { label: "Default mode" };
  }
  return { label: modeId };
}

function buildInitialThinkingDisplay(thinkingOptionId: string): ScheduleFormDisplay | null {
  if (!thinkingOptionId) {
    return null;
  }
  return { label: formatThinkingOptionLabel({ id: thinkingOptionId }) };
}

function formatInitialMaxRuns(schedule: ScheduleFormSnapshot["schedule"]): string {
  if (schedule?.maxRuns == null) {
    return "";
  }
  return String(schedule.maxRuns);
}

function isScheduleCompleted(schedule: ScheduleFormSnapshot["schedule"]): boolean {
  return schedule?.status === "completed";
}

function resolveInitialSubmitCadence(
  schedule: ScheduleFormSnapshot["schedule"],
  initialCadence: CronCadence,
): CronCadence | undefined {
  return schedule ? undefined : initialCadence;
}

function resolveInitialIsolation(input: {
  config: ReturnType<typeof newAgentConfig>;
  preferences: FormPreferences | undefined;
}): "local" | "worktree" {
  if (input.config) {
    return input.config.isolation ?? "local";
  }
  return input.preferences?.isolation ?? "local";
}

function resolveSelectedProjectOptionId(target: ScheduleProjectTarget | null): string {
  return target?.optionId ?? "";
}

function buildInitialProviderResolution(
  request: ScheduleProviderSnapshotRequest | null,
): Record<string, ProviderResolutionStatus> {
  if (!request) {
    return {};
  }
  return makeProviderResolutionRecord(request.serverId);
}

function resolveCanUseWorktreeIsolation(input: {
  state: Pick<ScheduleFormState, "selectedServerId" | "workingDir" | "selectedWorkspaceId">;
  hosts: readonly ScheduleFormHost[];
  targets: readonly ScheduleProjectTarget[];
}): boolean {
  const target = resolveProjectTarget({
    targets: input.targets,
    serverId: input.state.selectedServerId,
    cwd: input.state.workingDir,
    workspaceId: input.state.selectedWorkspaceId,
  });
  const host = input.hosts.find((entry) => entry.serverId === input.state.selectedServerId);
  return Boolean(target?.isGit && host?.supportsWorkspaceMultiplicity);
}

function selectedHostSupportsWorkspaceMultiplicity(input: {
  hosts: readonly ScheduleFormHost[];
  selectedServerId: string | null;
}): boolean {
  return (
    input.hosts.find((entry) => entry.serverId === input.selectedServerId)
      ?.supportsWorkspaceMultiplicity === true
  );
}

function resolveEffectiveIsolation(input: {
  isolation: "local" | "worktree";
  canUseWorktreeIsolation: boolean;
  selectedServerId: string | null;
  providerResolutionByServerId: Record<string, ProviderResolutionStatus>;
}): "local" | "worktree" {
  if (input.isolation !== "worktree") {
    return "local";
  }
  if (input.canUseWorktreeIsolation) {
    return "worktree";
  }
  if (
    !input.selectedServerId ||
    input.providerResolutionByServerId[input.selectedServerId] !== "complete"
  ) {
    return "worktree";
  }
  return "local";
}

function toWorkspaceOption(workspace: ScheduleProjectWorkspace): ScheduleFormWorkspaceOption {
  return {
    id: workspace.id,
    value: workspace.id,
    label: workspace.name,
    workspaceKind: workspace.workspaceKind,
    testID: `schedule-workspace-option-${workspace.id}`,
  };
}

function resolveWorkspaceView(input: {
  state: Pick<
    ScheduleFormState,
    "mode" | "scheduleCompleted" | "selectedServerId" | "selectedWorkspaceId"
  >;
  hosts: readonly ScheduleFormHost[];
  targets: readonly ScheduleProjectTarget[];
  projectTarget: ScheduleProjectTarget | null;
}): Pick<
  ScheduleFormState,
  | "workspaceOptions"
  | "selectedWorkspaceDisplay"
  | "workspaceLoading"
  | "workspaceError"
  | "submitWorkspaceId"
> {
  const { state, projectTarget } = input;
  const selectedWorkspaceId = state.selectedWorkspaceId;
  const host = input.hosts.find((entry) => entry.serverId === state.selectedServerId);
  const hostTargets = input.targets.filter((target) => target.serverId === state.selectedServerId);
  const hostWorkspace = selectedWorkspaceId
    ? hostTargets
        .flatMap((target) => target.workspaces)
        .find((workspace) => workspace.id === selectedWorkspaceId)
    : undefined;
  const unavailable =
    selectedWorkspaceId !== null &&
    !hostWorkspace &&
    canJudgeWorkspaceMissing({
      workspacesLoaded: host?.workspacesLoaded === true,
      hostOnline: host?.isOnline === true,
    });
  // A schedule that has already ended cannot be revived by editing, so a missing workspace is
  // not something to fix: like an unavailable agent it is only labeled, never an error, and
  // the stale id is not sent back (the server would reject it).
  const blocking = unavailable && !state.scheduleCompleted;
  // Background workspaces are not offered, because their finished runs leave History; a
  // schedule that is already bound to one keeps showing it.
  const selectable = (projectTarget?.workspaces ?? []).filter(
    (workspace) => !workspace.background || workspace.id === selectedWorkspaceId,
  );
  let selectedWorkspaceDisplay: ScheduleFormDisplay = { label: NEW_WORKSPACE_LABEL };
  if (selectedWorkspaceId !== null) {
    if (hostWorkspace) {
      selectedWorkspaceDisplay = { label: hostWorkspace.name };
    } else {
      selectedWorkspaceDisplay = {
        label: unavailable ? WORKSPACE_UNAVAILABLE_LABEL : "Loading...",
      };
    }
  }
  let submitWorkspaceId: string | null | undefined;
  if (host?.supportsWorkspaceTarget === true && !(unavailable && state.scheduleCompleted)) {
    submitWorkspaceId = selectedWorkspaceId ?? (state.mode === "edit" ? null : undefined);
  }
  return {
    workspaceOptions: [
      {
        id: NEW_WORKSPACE_OPTION_ID,
        value: NEW_WORKSPACE_OPTION_ID,
        label: NEW_WORKSPACE_LABEL,
        workspaceKind: null,
        testID: "schedule-workspace-option-new",
      },
      ...selectable.map(toWorkspaceOption),
    ],
    selectedWorkspaceDisplay,
    workspaceLoading: host?.workspacesLoaded !== true,
    workspaceError: blocking ? WORKSPACE_UNAVAILABLE_ERROR : null,
    submitWorkspaceId,
  };
}

function resolveDisclosure(state: ScheduleFormState): ScheduleDisclosureState {
  if (state.targetKind === "agent") {
    return {
      showProjectField: false,
      showModelField: false,
      showThinkingField: false,
      showModeField: false,
      showWorkspaceField: false,
      showIsolationField: false,
      showArchiveOnFinishField: false,
    };
  }

  const hasProject = state.workingDir.trim().length > 0;
  const hasSelectedProvider = Boolean(state.selectedProvider);
  const hasSelectedModel = Boolean(state.selectedProvider && state.selectedModel.trim());
  const showProjectField = state.mode === "edit" || Boolean(state.selectedServerId);
  const showModelField = hasProject;
  return {
    showProjectField,
    showModelField,
    showThinkingField:
      showModelField && hasSelectedModel && state.availableThinkingOptions.length > 0,
    showModeField: showModelField && hasSelectedProvider && state.modeOptions.length > 0,
    showWorkspaceField:
      hasProject &&
      state.hosts.find((entry) => entry.serverId === state.selectedServerId)
        ?.supportsWorkspaceTarget === true,
    showIsolationField:
      hasProject && state.canUseWorktreeIsolation && state.selectedWorkspaceId === null,
    showArchiveOnFinishField:
      hasProject &&
      selectedHostSupportsWorkspaceMultiplicity({
        hosts: state.hosts,
        selectedServerId: state.selectedServerId,
      }),
  };
}

function resolveCanSubmit(state: ScheduleFormState): boolean {
  if (state.targetKind === "agent") {
    return state.submitCadence !== undefined;
  }
  if (state.prompt.trim().length === 0) {
    return false;
  }
  const hasWorkingDir = state.workingDir.trim().length > 0;
  const hasMatchedProject = state.selectedProjectOptionId.trim().length > 0;
  if (state.mode === "create" && !hasMatchedProject) {
    return false;
  }
  if (!hasWorkingDir) {
    return false;
  }
  if (state.workspaceError !== null) {
    return false;
  }
  return isSelectedModelValidForProviders({
    providers: state.modelSelectorProviders,
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
  });
}

function updateDerivedState(input: {
  state: ScheduleFormState;
  hosts: readonly ScheduleFormHost[];
  targets: readonly ScheduleProjectTarget[];
  providerEntries: readonly ProviderSnapshotEntry[];
}): ScheduleFormState {
  const modeOptions = resolveModeOptions(input.providerEntries, input.state.selectedProvider);
  const availableThinkingOptions = resolveThinkingOptions(
    input.providerEntries,
    input.state.selectedProvider,
    input.state.selectedModel,
  );
  const canUseWorktreeIsolation = resolveCanUseWorktreeIsolation({
    state: input.state,
    hosts: input.hosts,
    targets: input.targets,
  });
  const canSubmitWorkspaceLifecycleOptions = selectedHostSupportsWorkspaceMultiplicity({
    hosts: input.hosts,
    selectedServerId: input.state.selectedServerId,
  });
  const effectiveIsolation = resolveEffectiveIsolation({
    isolation: input.state.isolation,
    canUseWorktreeIsolation,
    selectedServerId: input.state.selectedServerId,
    providerResolutionByServerId: input.state.providerResolutionByServerId,
  });
  const projectTarget = resolveProjectTarget({
    targets: input.targets,
    serverId: input.state.selectedServerId,
    cwd: input.state.workingDir,
    workspaceId: input.state.selectedWorkspaceId,
  });
  const nextState: ScheduleFormState = {
    ...input.state,
    hosts: [...input.hosts],
    projectOptions: buildProjectOptions(input.targets, input.state.selectedServerId),
    projectDisplay: resolveProjectDisplay({
      targets: input.targets,
      serverId: input.state.selectedServerId,
      cwd: input.state.workingDir,
      workspaceId: input.state.selectedWorkspaceId,
    }),
    ...resolveWorkspaceView({
      state: input.state,
      hosts: input.hosts,
      targets: input.targets,
      projectTarget,
    }),
    selectedProjectOptionId: projectTarget?.optionId ?? input.state.selectedProjectOptionId,
    selectedModelDisplay: resolveModelDisplay({
      entries: input.providerEntries,
      provider: input.state.selectedProvider,
      modelId: input.state.selectedModel,
    }),
    selectedModeDisplay: resolveModeDisplay({ modeOptions, modeId: input.state.selectedMode }),
    selectedThinkingDisplay: resolveThinkingDisplay({
      options: availableThinkingOptions,
      thinkingOptionId: input.state.selectedThinkingOptionId,
    }),
    modeOptions,
    availableThinkingOptions,
    canUseWorktreeIsolation,
    effectiveIsolation,
    submitArchiveOnFinish: canSubmitWorkspaceLifecycleOptions
      ? input.state.archiveOnFinish
      : undefined,
    submitIsolation:
      canSubmitWorkspaceLifecycleOptions && input.state.selectedWorkspaceId === null
        ? effectiveIsolation
        : undefined,
  };
  const disclosure = resolveDisclosure(nextState);
  return { ...nextState, disclosure, canSubmit: resolveCanSubmit({ ...nextState, disclosure }) };
}

function resolveBoundWorkspaceId(config: ReturnType<typeof newAgentConfig>): string | null {
  return config?.workspaceId ?? null;
}

function buildInitialState(snapshot: ScheduleFormSnapshot): ScheduleFormState {
  const selectedServerId = resolveInitialServerId(snapshot);
  const config = newAgentConfig(snapshot.schedule);
  const targetKind = resolveTargetKind(snapshot);
  const workingDir = config?.cwd ?? "";
  const boundWorkspaceId = resolveBoundWorkspaceId(config);
  const selectedProjectTarget = resolveProjectTarget({
    targets: snapshot.defaults.projectTargets,
    serverId: selectedServerId,
    cwd: workingDir,
    workspaceId: boundWorkspaceId,
  });
  const providerSnapshotRequest = buildProviderSnapshotRequest({
    targetKind,
    selectedServerId,
    workingDir,
  });
  const initialCadence = normalizeScheduleFormCadence(
    snapshot.schedule?.cadence ?? DEFAULT_CADENCE,
    snapshot.defaults.timezone ?? DEFAULT_TIMEZONE,
  );
  const initialModel = config?.model ?? "";
  const initialMode = config?.modeId ?? "";
  const initialThinking = config?.thinkingOptionId ?? "";
  const state: ScheduleFormState = {
    mode: snapshot.mode,
    scheduleCompleted: isScheduleCompleted(snapshot.schedule),
    targetKind,
    name: snapshot.schedule?.name ?? "",
    prompt: snapshot.schedule?.prompt ?? "",
    maxRuns: formatInitialMaxRuns(snapshot.schedule),
    cadence: initialCadence,
    submitCadence: resolveInitialSubmitCadence(snapshot.schedule, initialCadence),
    hosts: [...snapshot.hosts],
    projectOptions: buildProjectOptions(snapshot.defaults.projectTargets, selectedServerId),
    selectedServerId,
    selectedProvider: config?.provider ?? null,
    selectedModel: initialModel,
    selectedMode: initialMode,
    selectedThinkingOptionId: initialThinking,
    workingDir,
    projectDisplay: buildInitialProjectDisplay({
      config,
      targets: snapshot.defaults.projectTargets,
      selectedServerId,
    }),
    selectedProjectOptionId: resolveSelectedProjectOptionId(selectedProjectTarget),
    selectedModelDisplay: buildInitialModelDisplay(initialModel),
    selectedModeDisplay: buildInitialModeDisplay(initialMode),
    selectedThinkingDisplay: buildInitialThinkingDisplay(initialThinking),
    modelSelectorProviders: [],
    modeOptions: [],
    availableThinkingOptions: [],
    archiveOnFinish: config?.archiveOnFinish ?? true,
    isolation: resolveInitialIsolation({ config, preferences: snapshot.defaults.preferences }),
    effectiveIsolation: "local",
    selectedWorkspaceId: boundWorkspaceId,
    workspaceOptions: [],
    selectedWorkspaceDisplay: { label: NEW_WORKSPACE_LABEL },
    workspaceLoading: true,
    workspaceError: null,
    submitWorkspaceId: undefined,
    submitArchiveOnFinish: undefined,
    submitIsolation: undefined,
    canUseWorktreeIsolation: false,
    providerResolutionByServerId: buildInitialProviderResolution(providerSnapshotRequest),
    providerSnapshotRequest,
    disclosure: {
      showProjectField: false,
      showModelField: false,
      showThinkingField: false,
      showModeField: false,
      showWorkspaceField: false,
      showIsolationField: false,
      showArchiveOnFinishField: false,
    },
    canSubmit: false,
    submitError: null,
  };
  return updateDerivedState({
    state,
    hosts: snapshot.hosts,
    targets: snapshot.defaults.projectTargets,
    providerEntries: [],
  });
}

function toFormState(state: ScheduleFormState): FormState {
  return {
    provider: state.selectedProvider,
    modeId: state.selectedMode,
    model: state.selectedModel,
    thinkingOptionId: state.selectedThinkingOptionId,
  };
}

function applyResolvedFormState(state: ScheduleFormState, form: FormState): ScheduleFormState {
  return {
    ...state,
    selectedProvider: form.provider,
    selectedMode: form.modeId,
    selectedModel: form.model,
    selectedThinkingOptionId: form.thinkingOptionId,
  };
}

function resolveSnapshotSelection(input: {
  state: ScheduleFormState;
  snapshot: ScheduleFormSnapshot;
  initialValues: FormInitialValues | undefined;
  preferences: FormPreferences | null;
  providerEntries: ProviderSnapshotEntry[];
  userModified: UserModifiedFields;
}): ScheduleFormState {
  const providerDefinitions = buildProviderDefinitions(input.providerEntries);
  const allowedProviderMap = buildProviderDefinitionMapForStatuses({
    snapshotEntries: input.providerEntries,
    providerDefinitions,
    statuses: RESOLVABLE_PROVIDER_STATUSES,
  });
  const resolved = resolveFormStateFromProviderModels(
    input.initialValues,
    input.preferences,
    buildProviderModelsByProvider(input.providerEntries),
    input.userModified,
    toFormState(input.state),
    allowedProviderMap,
  );
  return applyResolvedFormState(input.state, resolved);
}

function preferencesForSnapshotResolution(
  snapshot: ScheduleFormSnapshot,
  preferences: FormPreferences | null,
): FormPreferences | null {
  return snapshot.mode === "edit" ? null : preferences;
}

function pickModeForProvider(input: {
  entries: readonly ProviderSnapshotEntry[];
  provider: AgentProvider;
  currentProvider: AgentProvider | null;
  currentMode: string;
}): string {
  const currentMode = input.currentMode.trim();
  if (input.currentProvider === input.provider && currentMode) {
    return currentMode;
  }
  const entry = resolveSelectedEntry(input.entries, input.provider);
  return entry?.defaultModeId ?? entry?.modes?.[0]?.id ?? "";
}

function pickModelForProvider(input: {
  entries: readonly ProviderSnapshotEntry[];
  provider: AgentProvider;
  modelId: string;
}): string {
  const normalizedModelId = input.modelId.trim();
  if (normalizedModelId) {
    return normalizedModelId;
  }
  return resolveDefaultModelId(resolveAvailableModels(input.entries, input.provider));
}

function thinkingDraftKey(provider: AgentProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

function seedThinkingDrafts(
  drafts: Map<string, string>,
  preferences: FormPreferences | null,
): void {
  for (const [provider, providerPreferences] of Object.entries(
    preferences?.providerPreferences ?? {},
  )) {
    for (const [modelId, thinkingOptionId] of Object.entries(
      providerPreferences?.thinkingByModel ?? {},
    )) {
      const key = thinkingDraftKey(provider as AgentProvider, modelId);
      if (!drafts.has(key)) {
        drafts.set(key, thinkingOptionId);
      }
    }
  }
}

function canonicalizeThinkingDrafts(
  drafts: Map<string, string>,
  entries: readonly ProviderSnapshotEntry[],
): void {
  for (const entry of entries) {
    const models = filterSelectableModels(entry.models ?? null);
    if (!models) {
      continue;
    }
    for (const model of models) {
      const canonicalKey = thinkingDraftKey(entry.provider, model.id);
      if (drafts.has(canonicalKey)) {
        continue;
      }
      const resolvedAlias = model.aliases?.find(
        (alias) =>
          findModelByReference(models, alias)?.id === model.id &&
          drafts.has(thinkingDraftKey(entry.provider, alias)),
      );
      if (!resolvedAlias) {
        continue;
      }
      const aliasedThinking = drafts.get(thinkingDraftKey(entry.provider, resolvedAlias));
      if (aliasedThinking !== undefined) {
        drafts.set(canonicalKey, aliasedThinking);
      }
    }
  }
}

export function openScheduleForm(snapshot: ScheduleFormSnapshot): ScheduleFormModel {
  const listeners = new Set<() => void>();
  const initialValues = normalizeInitialValues({
    snapshot,
  });
  let closed = false;
  let hosts = snapshot.hosts;
  let projectTargets = snapshot.defaults.projectTargets;
  let preferences = snapshot.defaults.preferences ?? null;
  const thinkingDrafts = new Map<string, string>();
  seedThinkingDrafts(thinkingDrafts, preferences);
  const initialAgentConfig = newAgentConfig(snapshot.schedule);
  if (
    initialAgentConfig?.provider &&
    initialAgentConfig.model &&
    initialAgentConfig.thinkingOptionId
  ) {
    thinkingDrafts.set(
      thinkingDraftKey(initialAgentConfig.provider, initialAgentConfig.model),
      initialAgentConfig.thinkingOptionId,
    );
  }
  let providerEntries: ProviderSnapshotEntry[] = [];
  let userModified = { ...INITIAL_USER_MODIFIED, isolation: false, archiveOnFinish: false };
  const timezone = snapshot.defaults.timezone ?? DEFAULT_TIMEZONE;
  let state = buildInitialState(snapshot);

  function publish(nextState: ScheduleFormState): void {
    if (closed) {
      return;
    }
    state = updateDerivedState({
      state: nextState,
      hosts,
      targets: projectTargets,
      providerEntries,
    });
    for (const listener of listeners) {
      listener();
    }
  }

  // Running in a shared workspace usually means the agents are meant to be read there, so a
  // new schedule stops archiving them unless the user has chosen otherwise.
  function withWorkspace(
    nextState: ScheduleFormState,
    workspaceId: string | null,
  ): ScheduleFormState {
    const archiveOnFinish =
      snapshot.mode === "create" && !userModified.archiveOnFinish
        ? workspaceId === null
        : nextState.archiveOnFinish;
    return { ...nextState, selectedWorkspaceId: workspaceId, archiveOnFinish };
  }

  function requestProviderSnapshot(serverId: string | null, cwd: string): void {
    const trimmedCwd = cwd.trim();
    if (!serverId || !trimmedCwd) {
      publish({
        ...state,
        providerSnapshotRequest: null,
      });
      return;
    }
    publish({
      ...state,
      providerResolutionByServerId: {
        ...state.providerResolutionByServerId,
        [serverId]: "pending",
      },
      providerSnapshotRequest: { serverId, cwd: trimmedCwd },
    });
  }

  function clearProviderSelection(nextState: ScheduleFormState): ScheduleFormState {
    providerEntries = [];
    return {
      ...nextState,
      selectedProvider: null,
      selectedModel: "",
      selectedMode: "",
      selectedThinkingOptionId: "",
      modelSelectorProviders: [],
      modeOptions: [],
      availableThinkingOptions: [],
      selectedModelDisplay: null,
      selectedModeDisplay: { label: "Default mode" },
      selectedThinkingDisplay: null,
      providerSnapshotRequest: null,
    };
  }

  function resolvePreferences(nextState: ScheduleFormState): ScheduleFormState {
    let resolved = nextState;
    if (
      snapshot.mode === "create" &&
      !userModified.isolation &&
      preferences?.isolation !== undefined
    ) {
      resolved = { ...resolved, isolation: preferences.isolation };
    }
    if (providerEntries.length === 0 || resolved.targetKind !== "new-agent") {
      return resolved;
    }
    return resolveSnapshotSelection({
      state: resolved,
      snapshot,
      initialValues,
      preferences: preferencesForSnapshotResolution(snapshot, preferences),
      providerEntries,
      userModified,
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applyHosts(nextHosts) {
      if (closed || hosts === nextHosts) {
        return;
      }
      hosts = nextHosts;
      publish(state);
    },
    applyProjectTargets(nextTargets) {
      if (closed || projectTargets === nextTargets) {
        return;
      }
      projectTargets = nextTargets;
      publish(state);
    },
    applyPreferences(nextPreferences) {
      const normalizedPreferences = nextPreferences ?? null;
      if (closed || preferences === normalizedPreferences) {
        return;
      }
      preferences = normalizedPreferences;
      seedThinkingDrafts(thinkingDrafts, preferences);
      publish(resolvePreferences(state));
    },
    applyProviderSnapshot(serverId, providerSnapshot) {
      if (closed || state.selectedServerId !== serverId) {
        return;
      }
      providerEntries = providerSnapshot.entries;
      canonicalizeThinkingDrafts(thinkingDrafts, providerEntries);
      const isPendingResolution = state.providerSnapshotRequest?.serverId === serverId;
      const resolved =
        state.targetKind === "new-agent"
          ? resolveSnapshotSelection({
              state,
              snapshot,
              initialValues,
              preferences: preferencesForSnapshotResolution(snapshot, preferences),
              providerEntries,
              userModified,
            })
          : state;
      const providerResolutionByServerId: Record<string, ProviderResolutionStatus> = {
        ...state.providerResolutionByServerId,
      };
      if (isPendingResolution) {
        providerResolutionByServerId[serverId] = "complete";
      }
      publish({
        ...resolved,
        modelSelectorProviders: buildSelectableProviderSelectorProviders(providerEntries),
        providerResolutionByServerId,
        providerSnapshotRequest: isPendingResolution ? null : state.providerSnapshotRequest,
      });
    },
    setHost(serverId) {
      if (closed || state.selectedServerId === serverId) {
        return;
      }
      publish(
        clearProviderSelection(
          withWorkspace(
            {
              ...state,
              selectedServerId: serverId,
              workingDir: "",
              projectDisplay: null,
              selectedProjectOptionId: "",
              providerResolutionByServerId: {},
            },
            null,
          ),
        ),
      );
    },
    setProject(optionId, display) {
      if (closed) {
        return;
      }
      const target = findProjectTargetByOptionId(projectTargets, optionId);
      if (!target) {
        return;
      }
      // Picking the project that is already selected changes nothing. workingDir cannot tell:
      // a schedule bound to a worktree workspace keeps that worktree's directory, not the
      // project root, so comparing it would reset the binding.
      if (
        state.selectedServerId === target.serverId &&
        state.selectedProjectOptionId === target.optionId
      ) {
        return;
      }
      const providerScopeChanged =
        state.selectedServerId !== target.serverId || state.workingDir !== target.cwd;
      const nextState = withWorkspace(
        {
          ...state,
          selectedServerId: target.serverId,
          workingDir: target.cwd,
          projectDisplay: display,
          selectedProjectOptionId: target.optionId,
        },
        null,
      );
      publish(providerScopeChanged ? clearProviderSelection(nextState) : nextState);
      if (!providerScopeChanged) {
        return;
      }
      requestProviderSnapshot(target.serverId, target.cwd);
    },
    setWorkspace(workspaceId) {
      if (closed || state.selectedWorkspaceId === workspaceId) {
        return;
      }
      // Binding keeps workingDir and unbinding to a project root changes it, and neither
      // refetches the provider list: the list was resolved for the project, and the daemon
      // runs the agent with the workspace's own directory regardless. A directory with a
      // different provider config only shows up as a failed run, which the schedule reports.
      if (workspaceId !== null) {
        publish(withWorkspace(state, workspaceId));
        return;
      }
      // A bound schedule stores the workspace's directory, which is not always the project
      // root. Going back to a workspace per run starts from the project root again; when the
      // project cannot be found (the workspace is gone), the project has to be chosen again.
      const projectTarget = findProjectTargetByOptionId(
        projectTargets,
        state.selectedProjectOptionId,
      );
      if (!projectTarget) {
        publish(
          clearProviderSelection(
            withWorkspace({ ...state, workingDir: "", selectedProjectOptionId: "" }, null),
          ),
        );
        return;
      }
      publish(withWorkspace({ ...state, workingDir: projectTarget.cwd }, null));
    },
    setModel(provider, modelId) {
      if (closed) {
        return;
      }
      const selectedModel = pickModelForProvider({ entries: providerEntries, provider, modelId });
      const availableModels = resolveAvailableModels(providerEntries, provider);
      const selectedThinkingOptionId = resolveThinkingOptionId({
        availableModels,
        modelId: selectedModel,
        requestedThinkingOptionId:
          thinkingDrafts.get(thinkingDraftKey(provider, selectedModel)) ?? "",
      });
      if (selectedModel && selectedThinkingOptionId) {
        thinkingDrafts.set(thinkingDraftKey(provider, selectedModel), selectedThinkingOptionId);
      }
      userModified = {
        ...userModified,
        provider: true,
        model: true,
        modeId: true,
        thinkingOptionId: true,
      };
      publish({
        ...state,
        selectedProvider: provider,
        selectedModel,
        selectedMode: pickModeForProvider({
          entries: providerEntries,
          provider,
          currentProvider: state.selectedProvider,
          currentMode: state.selectedMode,
        }),
        selectedThinkingOptionId,
      });
    },
    setThinking(thinkingOptionId) {
      if (closed) {
        return;
      }
      if (state.selectedProvider && state.selectedModel) {
        thinkingDrafts.set(
          thinkingDraftKey(state.selectedProvider, state.selectedModel),
          thinkingOptionId,
        );
      }
      userModified = { ...userModified, thinkingOptionId: true };
      publish({ ...state, selectedThinkingOptionId: thinkingOptionId });
    },
    setSessionMode(modeId) {
      if (closed) {
        return;
      }
      userModified = { ...userModified, modeId: true };
      publish({ ...state, selectedMode: modeId });
    },
    setName(value) {
      publish({ ...state, name: value });
    },
    setPrompt(value) {
      publish({ ...state, prompt: value });
    },
    setMaxRuns(value) {
      publish({ ...state, maxRuns: value });
    },
    setCadence(value) {
      const cadence = normalizeScheduleFormCadence(value, timezone);
      publish({ ...state, cadence, submitCadence: cadence });
    },
    setIsolation(value) {
      userModified = { ...userModified, isolation: true };
      publish({ ...state, isolation: value });
    },
    setArchiveOnFinish(value) {
      userModified = { ...userModified, archiveOnFinish: true };
      publish({ ...state, archiveOnFinish: value });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}
