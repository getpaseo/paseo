import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, Folder } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ScheduleCadence, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { getProviderIcon } from "@/components/provider-icons";
import { CadenceEditor } from "@/components/schedules/cadence-editor";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { useAgentFormState, type FormInitialValues } from "@/hooks/use-agent-form-state";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import {
  buildScheduleProjectTargets,
  PROJECT_OPTION_PREFIX,
  type ScheduleProjectTarget,
} from "@/schedules/schedule-project-targets";
import { validateCron } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";
import { shortenPath } from "@/utils/shorten-path";
import type { ProjectSummary } from "@/utils/projects";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

const DEFAULT_CADENCE: ScheduleCadence = { type: "every", everyMs: 60 * 60 * 1000 };

export interface ScheduleFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  schedule?: ScheduleSummary;
}

interface ScheduleProjectOptions {
  targets: ScheduleProjectTarget[];
  options: ComboboxOption[];
  targetByOptionId: Map<string, ScheduleProjectTarget>;
}

// The model/cwd config only exists on new-agent schedules; this screen filters
// to that target, but guard anyway so prefill stays type-safe.
function newAgentConfig(schedule: ScheduleSummary | undefined) {
  if (schedule && schedule.target.type === "new-agent") {
    return schedule.target.config;
  }
  return null;
}

function buildInitialValues(schedule: ScheduleSummary | undefined): FormInitialValues | undefined {
  const config = newAgentConfig(schedule);
  if (!config) {
    return undefined;
  }
  return {
    provider: config.provider as AgentProvider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    workingDir: config.cwd,
  };
}

function buildProjectOptionTestId(optionId: string): string {
  const targetKey = optionId.slice(PROJECT_OPTION_PREFIX.length).replace(/^[^:]+:/, "");
  return `schedule-project-option-${targetKey}`;
}

function buildScheduleProjectOptions(projects: readonly ProjectSummary[]): ScheduleProjectOptions {
  const targets = buildScheduleProjectTargets(projects);
  const targetByOptionId = new Map(targets.map((target) => [target.optionId, target]));
  const options: ComboboxOption[] = targets.map((target) => ({
    id: target.optionId,
    label: target.projectName,
    description: `${target.serverName} - ${shortenPath(target.cwd)}`,
  }));
  return { targets, options, targetByOptionId };
}

function resolveSelectedScheduleProjectTarget(input: {
  targets: readonly ScheduleProjectTarget[];
  serverId: string | null;
  cwd: string;
}): ScheduleProjectTarget | null {
  const cwd = input.cwd.trim();
  if (!input.serverId || !cwd) {
    return null;
  }
  return (
    input.targets.find((target) => target.serverId === input.serverId && target.cwd === cwd) ?? null
  );
}

function isSelectedModelValidForProviders(input: {
  providers: ProviderSelectorProvider[];
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

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canSubmitScheduleForm(input: {
  isAgentTarget: boolean;
  isEdit: boolean;
  promptTrimmed: string;
  cadenceError: string | null;
  isSubmitting: boolean;
  selectedModelIsValid: boolean;
  hasWorkingDir: boolean;
  hasSelectedProject: boolean;
}): boolean {
  if (input.promptTrimmed.length === 0 || input.cadenceError !== null || input.isSubmitting) {
    return false;
  }
  // Agent targets only edit name/prompt/cadence. New-agent edit accepts any
  // non-empty stored cwd; create requires a matched project.
  if (input.isAgentTarget) {
    return true;
  }
  if (!input.selectedModelIsValid) {
    return false;
  }
  return input.isEdit ? input.hasWorkingDir : input.hasSelectedProject;
}

export function ScheduleFormSheet({
  serverId,
  visible,
  onClose,
  mode,
  schedule,
}: ScheduleFormSheetProps): ReactElement {
  const isEdit = mode === "edit";
  // Agent-targeted schedules can only update name/prompt/cadence/maxRuns
  // (service.ts rejects newAgentConfig for them), so the form drops the
  // project/model/mode pickers and shows the target agent read-only instead.
  const isAgentTarget = isEdit && schedule?.target.type === "agent";
  const { projects } = useProjects();
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const projectOptions = useMemo(() => buildScheduleProjectOptions(projects), [projects]);

  const agentTargetLabel = useMemo(() => {
    if (!schedule || schedule.target.type !== "agent") {
      return null;
    }
    const { agentId } = schedule.target;
    const agent = agents.find((entry) => entry.serverId === serverId && entry.id === agentId);
    if (!agent) {
      return "Agent unavailable";
    }
    return agent.title?.trim() || "Untitled agent";
  }, [agents, schedule, serverId]);

  const onlineServerIds = useMemo(
    () => Array.from(new Set(projectOptions.targets.map((target) => target.serverId))),
    [projectOptions.targets],
  );
  const initialValues = useMemo(
    () => (isEdit ? buildInitialValues(schedule) : undefined),
    [isEdit, schedule],
  );

  // isCreateFlow drives useAgentFormState's RESOLVE pass that applies
  // initialValues. We want that for edit too (to prefill the picker fields from
  // the schedule's config), so this stays true in both modes: the form is
  // always a "fill these fields" flow, seeded either from preferences (create)
  // or from the schedule (edit).
  const form = useAgentFormState({
    initialServerId: serverId ?? null,
    initialValues,
    isVisible: visible,
    isCreateFlow: true,
    onlineServerIds,
  });

  const {
    selectedServerId,
    selectedProvider,
    selectedModel,
    selectedMode,
    selectedThinkingOptionId,
    workingDir,
    setProviderAndModelFromUser,
    clearProviderSelectionFromUser,
    setModeFromUser,
    setSelectedServerId,
    setSelectedServerIdFromUser,
    setWorkingDir,
    setWorkingDirFromUser,
    modeOptions,
    modelSelectorProviders,
    isAllModelsLoading,
    persistFormPreferences,
  } = form;

  const selectedProjectTarget = useMemo(
    () =>
      resolveSelectedScheduleProjectTarget({
        targets: projectOptions.targets,
        serverId: selectedServerId,
        cwd: workingDir,
      }),
    [projectOptions.targets, selectedServerId, workingDir],
  );
  const selectedProjectOptionId = selectedProjectTarget?.optionId ?? "";
  const mutationServerId = selectedProjectTarget?.serverId ?? selectedServerId ?? serverId ?? "";

  const handleSelectProject = useCallback(
    (target: ScheduleProjectTarget) => {
      // Compare against the current server, not the matched target: an unmatched
      // stored cwd has no target but still lives on a host, and switching hosts
      // must still clear a provider/model that may not exist on the new one.
      if (selectedServerId && selectedServerId !== target.serverId) {
        clearProviderSelectionFromUser();
      }
      setSelectedServerIdFromUser(target.serverId);
      setWorkingDirFromUser(target.cwd);
    },
    [
      clearProviderSelectionFromUser,
      selectedServerId,
      setSelectedServerIdFromUser,
      setWorkingDirFromUser,
    ],
  );

  // One nested control selects provider -> model (the draft screen's selector).
  // Render it as a full-width field that leads with the provider glyph and mutes
  // its placeholder, matching the working-directory field.
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
    }): ReactNode => (
      <ModelTrigger
        label={selectedModelLabel}
        provider={selectedProvider}
        disabled={disabled}
        active={hovered || pressed || isOpen}
        isPlaceholder={!selectedModel}
      />
    ),
    [selectedModel, selectedProvider],
  );

  const { createSchedule, updateSchedule, isCreating, isUpdating } = useScheduleMutations({
    serverId: mutationServerId,
  });
  const isSubmitting = isCreating || isUpdating;

  // Name / prompt / cadence / maxRuns are local to this form, not part of
  // useAgentFormState. Seed once per open from the schedule being edited.
  const [name, setName] = useState(() => schedule?.name ?? "");
  const [prompt, setPrompt] = useState(() => schedule?.prompt ?? "");
  const [maxRuns, setMaxRuns] = useState(() =>
    schedule?.maxRuns != null ? String(schedule.maxRuns) : "",
  );
  const [cadence, setCadence] = useState<ScheduleCadence>(
    () => schedule?.cadence ?? DEFAULT_CADENCE,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldResetKey, setFieldResetKey] = useState(0);

  // The sheet stays mounted across opens, so the lazy initializers above only
  // run once. Re-seed the locally-owned fields (name/prompt/cadence/maxRuns)
  // each time the sheet transitions closed -> open; the picker fields are
  // re-seeded by useAgentFormState from initialValues on the same flip.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setName(schedule?.name ?? "");
      setPrompt(schedule?.prompt ?? "");
      setMaxRuns(schedule?.maxRuns != null ? String(schedule.maxRuns) : "");
      setCadence(schedule?.cadence ?? DEFAULT_CADENCE);
      setSubmitError(null);
      setFieldResetKey((key) => key + 1);
      // The sheet stays mounted, and the form reducer's reset-on-close only
      // clears user-modified flags — not the picker values — so a create opened
      // after an edit would inherit that schedule's server/cwd (including a
      // stale ghost path). Clear them so create always starts fresh; provider
      // and model re-resolve from preferences.
      if (!isEdit) {
        setSelectedServerId(null);
        setWorkingDir("");
      }
    }
    wasVisibleRef.current = visible;
  }, [visible, schedule, isEdit, setSelectedServerId, setWorkingDir]);

  const promptTrimmed = prompt.trim();
  const trimmedWorkingDir = workingDir.trim();
  const cadenceError = cadence.type === "cron" ? validateCron(cadence.expression) : null;
  const selectedModelIsValid = isSelectedModelValidForProviders({
    providers: modelSelectorProviders,
    selectedProvider,
    selectedModel,
  });
  const canSubmit = canSubmitScheduleForm({
    isAgentTarget,
    isEdit,
    promptTrimmed,
    cadenceError,
    isSubmitting,
    selectedModelIsValid,
    hasWorkingDir: trimmedWorkingDir.length > 0,
    hasSelectedProject: Boolean(selectedProjectTarget),
  });

  // Agent target: the update RPC only accepts name/prompt/cadence/maxRuns.
  const submitAgentTarget = useCallback(async (): Promise<boolean> => {
    if (!schedule) {
      return false;
    }
    await updateSchedule({
      id: schedule.id,
      name: name.trim() || null,
      prompt: promptTrimmed,
      cadence,
      maxRuns: parseMaxRuns(maxRuns),
    });
    return true;
  }, [cadence, maxRuns, name, promptTrimmed, schedule, updateSchedule]);

  // New-agent target: submit the current working directory. On edit an untouched
  // picker leaves this as the stored cwd, so it round-trips unchanged.
  const submitNewAgent = useCallback(async (): Promise<boolean> => {
    if (!selectedProvider || !trimmedWorkingDir) {
      return false;
    }
    await persistFormPreferences();
    const maxRunsValue = parseMaxRuns(maxRuns);
    if (isEdit && schedule) {
      await updateSchedule({
        id: schedule.id,
        name: name.trim() || null,
        prompt: promptTrimmed,
        cadence,
        newAgentConfig: {
          provider: selectedProvider,
          model: selectedModel || null,
          modeId: selectedMode || null,
          cwd: trimmedWorkingDir,
        },
        maxRuns: maxRunsValue,
      });
      return true;
    }
    await createSchedule({
      prompt: promptTrimmed,
      name: name.trim() || undefined,
      cadence,
      target: {
        type: "new-agent",
        config: {
          provider: selectedProvider,
          cwd: trimmedWorkingDir,
          model: selectedModel || undefined,
          modeId: selectedMode || undefined,
          thinkingOptionId: selectedThinkingOptionId || undefined,
          title: name.trim() || undefined,
        },
      },
      ...(maxRunsValue != null ? { maxRuns: maxRunsValue } : {}),
    });
    return true;
  }, [
    cadence,
    createSchedule,
    isEdit,
    maxRuns,
    name,
    persistFormPreferences,
    promptTrimmed,
    schedule,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    trimmedWorkingDir,
    updateSchedule,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!promptTrimmed) {
      return;
    }
    setSubmitError(null);
    try {
      const submitted = isAgentTarget ? await submitAgentTarget() : await submitNewAgent();
      if (submitted) {
        onClose();
      }
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    }
  }, [isAgentTarget, onClose, promptTrimmed, submitAgentTarget, submitNewAgent]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({ title: isEdit ? "Edit schedule" : "New schedule" }),
    [isEdit],
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
          {isEdit ? "Save changes" : "Create schedule"}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isEdit, isSubmitting, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      webScrollbar
      testID="schedule-form-sheet"
    >
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <AdaptiveTextInput
          testID="schedule-name-input"
          accessibilityLabel="Schedule name"
          initialValue={name}
          resetKey={`schedule-name-${fieldResetKey}`}
          value={name}
          onChangeText={setName}
          placeholder="Optional"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Prompt</Text>
        <AdaptiveTextInput
          testID="schedule-prompt-input"
          accessibilityLabel="Prompt"
          initialValue={prompt}
          resetKey={`schedule-prompt-${fieldResetKey}`}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should the agent do each run?"
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </View>

      {isAgentTarget ? (
        <View style={styles.field}>
          <Text style={styles.label}>Target</Text>
          <View style={styles.readonlyField} testID="schedule-agent-target">
            <Text style={styles.selectTriggerText} numberOfLines={1}>
              {agentTargetLabel}
            </Text>
          </View>
          <Text style={styles.hint}>Runs against this existing agent.</Text>
        </View>
      ) : (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>Project</Text>
            <ProjectField
              options={projectOptions.options}
              targetByOptionId={projectOptions.targetByOptionId}
              value={selectedProjectOptionId}
              selectedTarget={selectedProjectTarget}
              fallbackCwd={workingDir}
              onSelect={handleSelectProject}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Model</Text>
            <CombinedModelSelector
              providers={modelSelectorProviders}
              selectedProvider={selectedProvider ?? ""}
              selectedModel={selectedModel}
              onSelect={setProviderAndModelFromUser}
              isLoading={isAllModelsLoading}
              renderTrigger={renderModelTrigger}
              triggerFill
              serverId={mutationServerId}
            />
          </View>

          {modeOptions.length > 0 ? (
            <ModeField
              options={modeOptions}
              selectedMode={selectedMode}
              onSelect={setModeFromUser}
            />
          ) : null}
        </>
      )}

      <View style={styles.field}>
        <Text style={styles.label}>Cadence</Text>
        <CadenceEditor value={cadence} onChange={setCadence} error={cadenceError ?? undefined} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Max runs</Text>
        <AdaptiveTextInput
          testID="schedule-max-runs-input"
          accessibilityLabel="Max runs"
          initialValue={maxRuns}
          resetKey={`schedule-max-runs-${fieldResetKey}`}
          value={maxRuns}
          onChangeText={setMaxRuns}
          placeholder="Unlimited"
          style={styles.input}
          keyboardType="number-pad"
        />
        <Text style={styles.hint}>Leave blank to run indefinitely</Text>
      </View>

      {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

// ---------------------------------------------------------------------------
// Mode field - Combobox over the selected provider's modes.
// ---------------------------------------------------------------------------

function ModeField({
  options,
  selectedMode,
  onSelect,
}: {
  options: { id: string; label: string }[];
  selectedMode: string;
  onSelect: (modeId: string) => void;
}): ReactElement {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const comboboxOptions = useMemo<ComboboxOption[]>(
    () => options.map((option) => ({ id: option.id, label: option.label })),
    [options],
  );

  const selectedLabel =
    options.find((option) => option.id === selectedMode)?.label ?? "Default mode";

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setOpen(false);
    },
    [onSelect],
  );

  const handlePress = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.selectTrigger,
      (Boolean(hovered) || pressed || open) && styles.selectTriggerActive,
    ],
    [open],
  );

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Mode</Text>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select mode (${selectedLabel})`}
          testID="schedule-mode-trigger"
        >
          <Text style={styles.selectTriggerText} numberOfLines={1}>
            {selectedLabel}
          </Text>
          <ChevronDown size={16} color={styles.chevron.color} />
        </Pressable>
      </View>
      <Combobox
        options={comboboxOptions}
        value={selectedMode}
        onSelect={handleSelect}
        searchable={comboboxOptions.length > 6}
        title="Select mode"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
      />
    </View>
  );
}

function ProjectField({
  options,
  targetByOptionId,
  value,
  selectedTarget,
  fallbackCwd,
  onSelect,
}: {
  options: ComboboxOption[];
  targetByOptionId: Map<string, ScheduleProjectTarget>;
  value: string;
  selectedTarget: ScheduleProjectTarget | null;
  /** Stored cwd for an edited schedule whose path matches no known project. */
  fallbackCwd: string;
  onSelect: (target: ScheduleProjectTarget) => void;
}): ReactElement {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      const target = targetByOptionId.get(id);
      if (!target) {
        return;
      }
      onSelect(target);
      setOpen(false);
    },
    [onSelect, targetByOptionId],
  );

  const handlePress = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.selectTrigger,
      (Boolean(hovered) || pressed || open) && styles.selectTriggerActive,
    ],
    [open],
  );

  // Honest hydration: a stored cwd that matches no known project shows the
  // shortened path itself (not the blank "Select project"), and stays put until
  // the user deliberately picks a project.
  const storedPath = fallbackCwd.trim();
  const displayValue =
    selectedTarget?.projectName ?? (storedPath ? shortenPath(storedPath) : "Select project");
  const isPlaceholder = !selectedTarget && !storedPath;
  const description = selectedTarget
    ? `${selectedTarget.serverName} - ${shortenPath(selectedTarget.cwd)}`
    : null;

  const renderOption = useCallback(
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
    }) => (
      <ProjectOptionItem option={option} selected={selected} active={active} onPress={onPress} />
    ),
    [],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select project (${displayValue})`}
          testID="schedule-project-trigger"
        >
          <Text
            style={isPlaceholder ? styles.selectTriggerPlaceholder : styles.selectTriggerText}
            numberOfLines={1}
          >
            {displayValue}
          </Text>
          <ChevronDown size={16} color={styles.chevron.color} />
        </Pressable>
      </View>
      {description ? <Text style={styles.hint}>{description}</Text> : null}
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        searchable
        searchPlaceholder="Search projects..."
        emptyText="No projects found"
        title="Select project"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        renderOption={renderOption}
      />
    </>
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.chevron.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={buildProjectOptionTestId(option.id)}
      label={option.label}
      description={option.description}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Dynamic provider glyph - reads its color off a StyleSheet object so the
 * runtime-resolved component stays compliant without useUnistyles. */
function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

// Non-interactive field rendered inside CombinedModelSelector's trigger (with
// triggerFill). The selector's outer Pressable owns press/hover; this leaf just
// paints the field and reads `active` for the focus border.
function ModelTrigger({
  label,
  provider,
  disabled,
  active,
  isPlaceholder,
}: {
  label: string;
  provider: string | null;
  disabled: boolean;
  active: boolean;
  isPlaceholder: boolean;
}): ReactElement {
  const containerStyle = useMemo(
    () => [
      styles.selectTrigger,
      active && styles.selectTriggerActive,
      disabled && styles.selectTriggerDisabled,
    ],
    [active, disabled],
  );
  return (
    <View pointerEvents="none" style={containerStyle} testID="schedule-model-trigger">
      <ProviderGlyph provider={provider} />
      <Text
        style={isPlaceholder ? styles.selectTriggerPlaceholder : styles.selectTriggerText}
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronDown size={16} color={styles.chevron.color} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  multilineInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
    minHeight: 96,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  readonlyField: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    minHeight: 44,
  },
  selectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    minHeight: 44,
  },
  selectTriggerActive: {
    borderColor: theme.colors.borderAccent,
  },
  selectTriggerDisabled: {
    opacity: theme.opacity[50],
  },
  selectTriggerText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  selectTriggerPlaceholder: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
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
  // Static color holders read by the dynamic provider icon + chevron (compliant
  // idiom - no useUnistyles in render).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
}));
