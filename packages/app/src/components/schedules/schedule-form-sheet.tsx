import equal from "fast-deep-equal";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { Brain, Folder, GitBranch } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { createControlGeometry, type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { getProviderIcon } from "@/components/provider-icons";
import { CadenceEditor } from "@/components/schedules/cadence-editor";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { formatThinkingOptionLabel } from "@/composer/agent-controls/utils";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildScheduleProjectTargets } from "@/schedules/schedule-project-targets";
import { useScheduleFormModel } from "@/schedules/use-schedule-form-model";
import { useScheduleFormProviderSnapshot } from "@/schedules/use-schedule-form-provider-snapshot";
import type {
  ScheduleFormDisplay,
  ScheduleFormHost,
  ScheduleFormModel,
  ScheduleFormSnapshot,
  ScheduleFormState,
} from "@/schedules/schedule-form-model";
import { validateCron } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";
import { getDeviceTimeZone } from "@/utils/device-timezone";

export interface ScheduleFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  schedule?: ScheduleSummary;
}

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveCreateServerId(input: {
  mode: "create" | "edit";
  serverId: string | null | undefined;
  hosts: readonly ScheduleFormHost[];
}): string | null {
  if (input.mode === "edit") {
    return input.serverId ?? null;
  }
  if (input.serverId !== undefined) {
    return input.serverId;
  }
  if (input.hosts.length === 1) {
    return input.hosts[0]?.serverId ?? null;
  }
  return null;
}

function buildScheduleHostOptionTestId(serverId: string): string {
  return `schedule-host-option-${serverId}`;
}

function buildThinkingOptionTestId(optionId: string): string {
  return `schedule-thinking-option-${optionId}`;
}

function openKey(props: ScheduleFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId ?? ""}:${props.schedule?.id ?? ""}`;
  }
  return `create:${props.serverId ?? ""}`;
}

function selectScheduleHosts(
  hosts: readonly { serverId: string; label: string }[],
): (state: ReturnType<typeof useSessionStore.getState>) => ScheduleFormHost[] {
  return (state) =>
    hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      supportsWorkspaceMultiplicity:
        state.sessions[host.serverId]?.serverInfo?.features?.workspaceMultiplicity === true,
    }));
}

function buildSnapshot(input: {
  mode: "create" | "edit";
  serverId: string | undefined;
  schedule: ScheduleSummary | undefined;
  hosts: readonly ScheduleFormHost[];
  projectTargets: ReturnType<typeof buildScheduleProjectTargets>;
  preferences: FormPreferences;
  timezone: string;
}): ScheduleFormSnapshot {
  const schedule = input.schedule
    ? { ...input.schedule, serverId: input.serverId, serverName: undefined }
    : undefined;
  return {
    mode: input.mode,
    schedule,
    hosts: input.hosts,
    defaults: {
      serverId: resolveCreateServerId({
        mode: input.mode,
        serverId: input.serverId,
        hosts: input.hosts,
      }),
      projectTargets: input.projectTargets,
      preferences: input.preferences,
      timezone: input.timezone,
    },
  };
}

function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        model: model || undefined,
        mode: mode || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    isolation: input.isolation,
  };
}

export function ScheduleFormSheet(props: ScheduleFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<ScheduleFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenScheduleFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenScheduleFormSheet({
  serverId,
  visible,
  onClose,
  onDismiss,
  mode,
  schedule,
}: ScheduleFormSheetProps & { onDismiss: () => void }): ReactElement {
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useStoreWithEqualityFn(
    useSessionStore,
    useMemo(() => selectScheduleHosts(hostProfiles), [hostProfiles]),
    equal,
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildScheduleProjectTargets(projects), [projects]);
  const timezone = useMemo(getDeviceTimeZone, []);
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        mode,
        serverId,
        schedule,
        hosts,
        projectTargets,
        preferences,
        timezone,
      }),
    [hosts, mode, preferences, projectTargets, schedule, serverId, timezone],
  );
  const model = useScheduleFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providerSnapshot = useScheduleFormProviderSnapshot(model, state);
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const mutationServerId = state.selectedServerId ?? serverId ?? "";
  const { createSchedule, updateSchedule, isCreating, isUpdating } = useScheduleMutations({
    serverId: mutationServerId,
  });

  const isSubmitting = isCreating || isUpdating;
  const cadenceError =
    state.cadence.type === "cron" ? validateCron(state.cadence.expression) : null;
  const canSubmit = state.canSubmit && cadenceError === null && !isSubmitting;
  const agentTargetLabel = useMemo(() => {
    if (!schedule || schedule.target.type !== "agent") {
      return null;
    }
    const { agentId } = schedule.target;
    const agent = agents.find(
      (entry) => entry.serverId === (state.selectedServerId ?? serverId) && entry.id === agentId,
    );
    if (!agent) {
      return "Agent unavailable";
    }
    return agent.title?.trim() || "Untitled agent";
  }, [agents, schedule, serverId, state.selectedServerId]);

  const persistPreferences = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) {
      return;
    }
    await updatePreferences((current) =>
      updateSelectionPreferences({
        preferences: current,
        provider,
        model: state.selectedModel,
        mode: state.selectedMode,
        thinkingOptionId: state.selectedThinkingOptionId,
        isolation: state.isolation,
      }),
    );
  }, [
    state.isolation,
    state.selectedMode,
    state.selectedModel,
    state.selectedProvider,
    state.selectedThinkingOptionId,
    updatePreferences,
  ]);

  const submitAgentTarget = useCallback(async (): Promise<boolean> => {
    if (!schedule) {
      return false;
    }
    await updateSchedule({
      id: schedule.id,
      name: state.name.trim() || null,
      prompt: state.prompt.trim(),
      cadence: state.submitCadence,
      maxRuns: parseMaxRuns(state.maxRuns),
    });
    return true;
  }, [schedule, state.maxRuns, state.name, state.prompt, state.submitCadence, updateSchedule]);

  const submitNewAgent = useCallback(async (): Promise<boolean> => {
    const provider = state.selectedProvider;
    const cwd = state.workingDir.trim();
    if (!provider || !cwd) {
      return false;
    }

    await persistPreferences();
    const maxRuns = parseMaxRuns(state.maxRuns);
    if (mode === "edit" && schedule) {
      await updateSchedule({
        id: schedule.id,
        name: state.name.trim() || null,
        prompt: state.prompt.trim(),
        cadence: state.submitCadence,
        newAgentConfig: {
          provider,
          model: state.selectedModel || null,
          modeId: state.selectedMode || null,
          thinkingOptionId: state.selectedThinkingOptionId || null,
          cwd,
          ...(state.submitArchiveOnFinish !== undefined
            ? { archiveOnFinish: state.submitArchiveOnFinish }
            : {}),
          ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}),
        },
        maxRuns,
      });
      return true;
    }

    await createSchedule({
      prompt: state.prompt.trim(),
      name: state.name.trim() || undefined,
      cadence: state.submitCadence,
      target: {
        type: "new-agent",
        config: {
          provider,
          cwd,
          model: state.selectedModel || undefined,
          modeId: state.selectedMode || undefined,
          thinkingOptionId: state.selectedThinkingOptionId || undefined,
          ...(state.submitArchiveOnFinish !== undefined
            ? { archiveOnFinish: state.submitArchiveOnFinish }
            : {}),
          ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}),
          title: state.name.trim() || undefined,
        },
      },
      ...(maxRuns != null ? { maxRuns } : {}),
    });
    return true;
  }, [createSchedule, mode, persistPreferences, schedule, state, updateSchedule]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      const submitted =
        state.targetKind === "agent" ? await submitAgentTarget() : await submitNewAgent();
      if (submitted) {
        onClose();
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, model, onClose, state.targetKind, submitAgentTarget, submitNewAgent]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: mode === "edit" ? "Edit schedule" : "New schedule" }),
    [mode],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="schedule-form-submit"
        >
          {mode === "edit" ? "Save changes" : "Create schedule"}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="schedule-form-sheet"
    >
      <ScheduleFormFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        cadenceError={cadenceError}
        mutationServerId={mutationServerId}
      />
    </AdaptiveModalSheet>
  );
}

interface ScheduleFormFieldsProps {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  providerSnapshot: ReturnType<typeof useScheduleFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  cadenceError: string | null;
  mutationServerId: string;
}

function ScheduleFormFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  cadenceError,
  mutationServerId,
}: ScheduleFormFieldsProps): ReactElement {
  return (
    <>
      <Field label="Name">
        <FormTextInput
          size={controlSize}
          testID="schedule-name-input"
          accessibilityLabel="Schedule name"
          initialValue={state.name}
          value={state.name}
          onChangeText={model.setName}
          placeholder="Optional"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label="Prompt">
        <FormTextInput
          size={controlSize}
          testID="schedule-prompt-input"
          accessibilityLabel="Prompt"
          initialValue={state.prompt}
          value={state.prompt}
          onChangeText={model.setPrompt}
          placeholder="What should the agent do each run?"
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>

      <ScheduleTargetFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />

      <CadenceEditor
        value={state.cadence}
        onChange={model.setCadence}
        error={cadenceError ?? undefined}
        size={controlSize}
      />

      <Field label="Max runs">
        <FormTextInput
          size={controlSize}
          testID="schedule-max-runs-input"
          accessibilityLabel="Max runs"
          initialValue={state.maxRuns}
          value={state.maxRuns}
          onChangeText={model.setMaxRuns}
          placeholder="Unlimited"
          keyboardType="number-pad"
        />
      </Field>

      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </>
  );
}

interface ScheduleTargetFieldsProps {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  providerSnapshot: ReturnType<typeof useScheduleFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  mutationServerId: string;
}

function ScheduleTargetFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  mutationServerId,
}: ScheduleTargetFieldsProps): ReactElement {
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: buildScheduleHostOptionTestId(host.serverId),
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId) ?? null;
  const selectedHostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (selectedHost) {
      return { label: selectedHost.label };
    }
    if (state.selectedServerId) {
      return { label: state.selectedServerId };
    }
    return null;
  }, [selectedHost, state.selectedServerId]);
  const projectOptions = state.projectOptions;
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.modeOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    [state.modeOptions],
  );
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.availableThinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        testID: buildThinkingOptionTestId(option.id),
      })),
    [state.availableThinkingOptions],
  );
  const handleSelectHost = useCallback(
    (nextServerId: string) => {
      model.setHost(nextServerId);
    },
    [model],
  );
  const handleSelectProject = useCallback(
    (optionId: string, display: ScheduleFormDisplay) => {
      model.setProject(optionId, display);
    },
    [model],
  );
  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModel(provider, modelId);
    },
    [model],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      model.setSessionMode(modeId);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (thinkingOptionId: string) => {
      model.setThinking(thinkingOptionId);
    },
    [model],
  );
  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(state.selectedProvider);
  }, [providerSnapshot, state.selectedProvider]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  const modelTriggerLeading = useMemo(
    () => <ProviderGlyph provider={state.selectedProvider} />,
    [state.selectedProvider],
  );
  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => {
      const displayLabel = state.selectedModelDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.selectedModel}
          placeholder={displayLabel}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="schedule-model-trigger"
        />
      );
    },
    [controlSize, modelTriggerLeading, state.selectedModel, state.selectedModelDisplay],
  );

  if (state.targetKind === "agent") {
    return <ScheduleAgentTargetField label={agentTargetLabel} size={controlSize} />;
  }

  return (
    <>
      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label="Host"
          value={state.selectedServerId}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={handleSelectHost}
          placeholder="Select host"
          emptyText="No hosts found"
          disabled={state.mode === "edit"}
          searchable={false}
          title="Host"
          size={controlSize}
          triggerTestID="schedule-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}

      {state.disclosure.showProjectField ? (
        <SelectField
          label="Project"
          value={state.selectedProjectOptionId || null}
          selectedDisplay={state.projectDisplay}
          options={projectOptions}
          onChange={handleSelectProject}
          placeholder="Select project"
          emptyText="No projects found"
          disabled={!state.selectedServerId}
          hint={!state.selectedServerId ? "Choose a host first." : undefined}
          searchable
          searchPlaceholder="Search projects..."
          title="Select project"
          size={controlSize}
          triggerTestID="schedule-project-trigger"
          renderOption={renderProjectOption}
        />
      ) : null}

      {state.disclosure.showModelField ? (
        <Field label="Model">
          <CombinedModelSelector
            providers={state.modelSelectorProviders}
            selectedProvider={state.selectedProvider ?? ""}
            selectedModel={state.selectedModel}
            onSelect={handleSelectModel}
            isLoading={providerSnapshot.isLoading || providerSnapshot.isFetching}
            renderTrigger={renderModelTrigger}
            triggerFill
            serverId={mutationServerId}
            disabled={!state.selectedServerId}
            onOpen={handleModelOpen}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={providerSnapshot.isRefreshing}
          />
        </Field>
      ) : null}

      {state.disclosure.showThinkingField ? (
        <SelectField
          label="Thinking"
          value={state.selectedThinkingOptionId || null}
          selectedDisplay={state.selectedThinkingDisplay}
          options={thinkingOptions}
          onChange={handleSelectThinking}
          placeholder="Select thinking"
          emptyText="No thinking options found"
          searchable={thinkingOptions.length > 6}
          title="Select thinking"
          size={controlSize}
          triggerTestID="schedule-thinking-trigger"
          renderOption={renderThinkingOption}
        />
      ) : null}

      {state.disclosure.showModeField ? (
        <SelectField
          label="Mode"
          value={state.selectedMode || null}
          selectedDisplay={state.selectedModeDisplay}
          options={modeOptions}
          onChange={handleSelectMode}
          placeholder="Default mode"
          emptyText="No modes found"
          disabled={modeOptions.length === 0}
          hint={modeOptions.length === 0 ? "No modes are available for this model." : undefined}
          searchable={modeOptions.length > 6}
          title="Select mode"
          size={controlSize}
          triggerTestID="schedule-mode-trigger"
        />
      ) : null}

      {state.disclosure.showIsolationField ? (
        <ScheduleIsolationField model={model} state={state} size={controlSize} />
      ) : null}

      {state.disclosure.showArchiveOnFinishField ? (
        <Field label="Archive on finish">
          <Switch
            value={state.archiveOnFinish}
            onValueChange={model.setArchiveOnFinish}
            accessibilityLabel="Archive on finish"
            testID="schedule-archive-on-finish-switch"
          />
        </Field>
      ) : null}
    </>
  );
}

function ScheduleIsolationField({
  model,
  state,
  size,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  size: FieldControlSize;
}): ReactElement {
  const options = useMemo<SelectFieldOption<"local" | "worktree">[]>(
    () => [
      {
        id: "local",
        value: "local",
        label: "Local",
        testID: "schedule-isolation-local",
      },
      {
        id: "worktree",
        value: "worktree",
        label: "Worktree",
        testID: "schedule-isolation-worktree",
      },
    ],
    [],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({ label: state.effectiveIsolation === "worktree" ? "Worktree" : "Local" }),
    [state.effectiveIsolation],
  );
  const triggerLeading = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {state.effectiveIsolation === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [state.effectiveIsolation],
  );
  const handleSelectIsolation = useCallback(
    (value: "local" | "worktree") => {
      model.setIsolation(value);
    },
    [model],
  );
  const renderIsolationOption = useCallback(
    (input: SelectFieldRenderOptionInput<"local" | "worktree">) => (
      <IsolationOptionItem {...input} />
    ),
    [],
  );

  return (
    <SelectField
      label="Isolation"
      value={state.effectiveIsolation}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleSelectIsolation}
      placeholder="Select isolation"
      emptyText="No isolation options found"
      searchable={false}
      title="Isolation"
      size={size}
      testID="schedule-isolation"
      triggerTestID="schedule-isolation-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderIsolationOption}
    />
  );
}

function ScheduleAgentTargetField({
  label,
  size,
}: {
  label: string | null;
  size: FieldControlSize;
}): ReactElement {
  const fieldStyle = useMemo(
    () => [styles.readonlyField, size === "sm" ? styles.readonlyFieldSm : styles.readonlyFieldMd],
    [size],
  );
  const textStyle = useMemo(
    () => [styles.readonlyText, size === "sm" ? styles.readonlyTextSm : styles.readonlyTextMd],
    [size],
  );

  return (
    <Field label="Target">
      <View style={fieldStyle} testID="schedule-agent-target">
        <Text style={textStyle} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Field>
  );
}

function IsolationOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<"local" | "worktree">): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {option.value === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [option.value],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ThinkingOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Brain size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    multilineInput: {
      minHeight: 96,
    },
    readonlyField: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    readonlyFieldSm: {
      ...geometry.formTextInputSm,
    },
    readonlyFieldMd: {
      ...geometry.formTextInputMd,
    },
    readonlyText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
    },
    readonlyTextSm: {
      fontSize: theme.fontSize.sm,
    },
    readonlyTextMd: {
      fontSize: theme.fontSize.base,
    },
    optionIconBox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    footer: {
      flex: 1,
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    footerButton: {
      flex: 1,
    },
    submitError: {
      color: theme.colors.palette.red[300],
      fontSize: theme.fontSize.xs,
    },
    providerIcon: {
      color: theme.colors.foregroundMuted,
    },
  };
});
