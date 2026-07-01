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
import { useProjects } from "@/hooks/use-projects";
import { validateCron } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";
import { shortenPath } from "@/utils/shorten-path";
import type { ProjectSummary } from "@/utils/projects";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

const DEFAULT_CADENCE: ScheduleCadence = { type: "every", everyMs: 60 * 60 * 1000 };
const PROJECT_OPTION_PREFIX = "project:";

export interface ScheduleFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  schedule?: ScheduleSummary;
}

interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectKey: string;
  projectName: string;
  cwd: string;
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

function buildProjectOptionId(serverId: string, projectKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectKey}`;
}

function buildProjectOptionTestId(optionId: string): string {
  const targetKey = optionId.slice(PROJECT_OPTION_PREFIX.length).replace(/^[^:]+:/, "");
  return `schedule-project-option-${targetKey}`;
}

function buildScheduleProjectOptions(projects: readonly ProjectSummary[]): ScheduleProjectOptions {
  const targets: ScheduleProjectTarget[] = [];
  const targetByOptionId = new Map<string, ScheduleProjectTarget>();
  const options: ComboboxOption[] = [];

  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      const target: ScheduleProjectTarget = {
        optionId: buildProjectOptionId(host.serverId, project.projectKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectKey: project.projectKey,
        projectName: project.projectName,
        cwd,
      };
      targets.push(target);
      targetByOptionId.set(target.optionId, target);
      options.push({
        id: target.optionId,
        label: target.projectName,
        description: `${target.serverName} - ${shortenPath(cwd)}`,
      });
    }
  }

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

export function ScheduleFormSheet({
  serverId,
  visible,
  onClose,
  mode,
  schedule,
}: ScheduleFormSheetProps): ReactElement {
  const isEdit = mode === "edit";
  const editConfig = newAgentConfig(schedule);
  const { projects } = useProjects();
  const projectOptions = useMemo(() => buildScheduleProjectOptions(projects), [projects]);

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
    setSelectedServerIdFromUser,
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
      if (selectedProjectTarget && selectedProjectTarget.serverId !== target.serverId) {
        clearProviderSelectionFromUser();
      }
      setSelectedServerIdFromUser(target.serverId);
      setWorkingDirFromUser(target.cwd);
    },
    [
      clearProviderSelectionFromUser,
      selectedProjectTarget,
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
    }
    wasVisibleRef.current = visible;
  }, [visible, schedule]);

  const promptTrimmed = prompt.trim();
  const cadenceError = cadence.type === "cron" ? validateCron(cadence.expression) : null;
  const selectedModelIsValid = isSelectedModelValidForProviders({
    providers: modelSelectorProviders,
    selectedProvider,
    selectedModel,
  });
  const canSubmit =
    promptTrimmed.length > 0 &&
    selectedModelIsValid &&
    Boolean(selectedProjectTarget) &&
    cadenceError === null &&
    !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!selectedProvider || !selectedProjectTarget || !promptTrimmed) {
      return;
    }
    setSubmitError(null);
    try {
      await persistFormPreferences();
      const parsedMaxRuns = Number.parseInt(maxRuns, 10);
      const maxRunsValue =
        Number.isFinite(parsedMaxRuns) && parsedMaxRuns > 0 ? parsedMaxRuns : null;

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
            cwd: selectedProjectTarget.cwd,
          },
          maxRuns: maxRunsValue,
        });
      } else {
        await createSchedule({
          prompt: promptTrimmed,
          name: name.trim() || undefined,
          cadence,
          target: {
            type: "new-agent",
            config: {
              provider: selectedProvider,
              cwd: selectedProjectTarget.cwd,
              model: selectedModel || undefined,
              modeId: selectedMode || undefined,
              thinkingOptionId: selectedThinkingOptionId || undefined,
              title: name.trim() || undefined,
            },
          },
          ...(maxRunsValue != null ? { maxRuns: maxRunsValue } : {}),
        });
      }
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    }
  }, [
    cadence,
    createSchedule,
    isEdit,
    maxRuns,
    name,
    onClose,
    persistFormPreferences,
    promptTrimmed,
    schedule,
    selectedMode,
    selectedModel,
    selectedProjectTarget,
    selectedProvider,
    selectedThinkingOptionId,
    updateSchedule,
  ]);

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

      <View style={styles.field}>
        <Text style={styles.label}>Project</Text>
        <ProjectField
          options={projectOptions.options}
          targetByOptionId={projectOptions.targetByOptionId}
          value={selectedProjectOptionId}
          selectedTarget={selectedProjectTarget}
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
        <ModeField options={modeOptions} selectedMode={selectedMode} onSelect={setModeFromUser} />
      ) : null}

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

      {editConfig === null && isEdit ? (
        <Text style={styles.hint}>This schedule does not target a new agent.</Text>
      ) : null}

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
  onSelect,
}: {
  options: ComboboxOption[];
  targetByOptionId: Map<string, ScheduleProjectTarget>;
  value: string;
  selectedTarget: ScheduleProjectTarget | null;
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

  const displayValue = selectedTarget?.projectName ?? "Select project";
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
            style={selectedTarget ? styles.selectTriggerText : styles.selectTriggerPlaceholder}
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
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
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
