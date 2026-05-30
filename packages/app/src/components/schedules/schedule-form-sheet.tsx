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
import { ChevronDown } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
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
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";
import { validateCron } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";
import { shortenPath } from "@/utils/shorten-path";

const DEFAULT_CADENCE: ScheduleCadence = { type: "every", everyMs: 60 * 60 * 1000 };

export interface ScheduleFormSheetProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  schedule?: ScheduleSummary;
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
    serverId: null,
    provider: config.provider as AgentProvider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    workingDir: config.cwd,
  };
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

  const onlineServerIds = useMemo(() => [serverId], [serverId]);
  const initialValues = useMemo(
    () => (isEdit ? buildInitialValues(schedule) : undefined),
    [isEdit, schedule],
  );

  // isCreateFlow drives useAgentFormState's RESOLVE pass that applies
  // initialValues. We want that for edit too (to prefill the picker fields from
  // the schedule's config), so this stays true in both modes — the form is
  // always a "fill these fields" flow, seeded either from preferences (create)
  // or from the schedule (edit).
  const form = useAgentFormState({
    initialServerId: serverId,
    initialValues,
    isVisible: visible,
    isCreateFlow: true,
    onlineServerIds,
  });

  const {
    selectedProvider,
    selectedModel,
    selectedMode,
    selectedThinkingOptionId,
    workingDir,
    setProviderFromUser,
    setProviderAndModelFromUser,
    setModeFromUser,
    setWorkingDirFromUser,
    providerDefinitions,
    modeOptions,
    modelSelectorProviders,
    isAllModelsLoading,
    persistFormPreferences,
  } = form;

  const { createSchedule, updateSchedule, isCreating, isUpdating } = useScheduleMutations({
    serverId,
  });
  const isSubmitting = isCreating || isUpdating;

  // Name / prompt / cadence / maxRuns are local to this form — not part of
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
  const canSubmit =
    promptTrimmed.length > 0 &&
    Boolean(selectedProvider) &&
    workingDir.trim().length > 0 &&
    cadenceError === null &&
    !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!selectedProvider || !workingDir.trim() || !promptTrimmed) {
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
            cwd: workingDir.trim(),
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
              cwd: workingDir.trim(),
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
    selectedProvider,
    selectedThinkingOptionId,
    updateSchedule,
    workingDir,
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

      <ProviderField
        providerDefinitions={providerDefinitions}
        selectedProvider={selectedProvider}
        onSelect={setProviderFromUser}
      />

      <View style={styles.field}>
        <Text style={styles.label}>Model</Text>
        <CombinedModelSelector
          providers={modelSelectorProviders}
          selectedProvider={selectedProvider ?? ""}
          selectedModel={selectedModel}
          onSelect={setProviderAndModelFromUser}
          isLoading={isAllModelsLoading}
          renderTrigger={renderModelTrigger}
          serverId={serverId}
        />
      </View>

      {modeOptions.length > 0 ? (
        <ModeField options={modeOptions} selectedMode={selectedMode} onSelect={setModeFromUser} />
      ) : null}

      <WorkingDirectoryField
        serverId={serverId}
        value={workingDir}
        onSelect={setWorkingDirFromUser}
        visible={visible}
      />

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
// Provider field — Combobox over providerDefinitions, each option led by its
// provider glyph. Trigger mirrors the desktop badge pattern from the composer.
// ---------------------------------------------------------------------------

function ProviderField({
  providerDefinitions,
  selectedProvider,
  onSelect,
}: {
  providerDefinitions: { id: string; label: string }[];
  selectedProvider: AgentProvider | null;
  onSelect: (provider: AgentProvider) => void;
}): ReactElement {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const options = useMemo<ComboboxOption[]>(
    () => providerDefinitions.map((definition) => ({ id: definition.id, label: definition.label })),
    [providerDefinitions],
  );

  const selectedLabel =
    providerDefinitions.find((definition) => definition.id === selectedProvider)?.label ??
    "Select provider";

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id as AgentProvider);
      setOpen(false);
    },
    [onSelect],
  );

  const handlePress = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const renderProviderOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean; onPress: () => void }) => (
      <ProviderComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
      />
    ),
    [],
  );

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.selectTrigger,
      (Boolean(hovered) || pressed || open) && styles.selectTriggerActive,
    ],
    [open],
  );

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Provider</Text>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select provider (${selectedLabel})`}
          testID="schedule-provider-trigger"
        >
          <ProviderGlyph provider={selectedProvider} />
          <Text style={styles.selectTriggerText} numberOfLines={1}>
            {selectedLabel}
          </Text>
          <ChevronDown size={16} color={styles.chevron.color} />
        </Pressable>
      </View>
      <Combobox
        options={options}
        value={selectedProvider ?? ""}
        onSelect={handleSelect}
        searchable={options.length > 6}
        title="Select provider"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        renderOption={renderProviderOption}
        desktopPlacement="bottom-start"
      />
    </View>
  );
}

function ProviderComboboxOption({
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
  const leadingSlot = useMemo(() => <ProviderGlyph provider={option.id} />, [option.id]);
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

// ---------------------------------------------------------------------------
// Mode field — Combobox over the selected provider's modes.
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

// ---------------------------------------------------------------------------
// Working directory — searchable Combobox backed by directory suggestions,
// allowing a custom path. Mirrors the project picker's query shape.
// ---------------------------------------------------------------------------

function WorkingDirectoryField({
  serverId,
  value,
  onSelect,
  visible,
}: {
  serverId: string;
  value: string;
  onSelect: (value: string) => void;
  visible: boolean;
}): ReactElement {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const recommendedPaths = useRecommendedProjectPaths(serverId);

  const directorySuggestionsQuery = useQuery({
    queryKey: ["schedule-form-directory-suggestions", serverId, query],
    queryFn: async () => {
      if (!client) {
        return [];
      }
      const result = await client.getDirectorySuggestions({
        query,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : []));
    },
    enabled: Boolean(client) && isConnected && visible && open,
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo<ComboboxOption[]>(() => {
    const paths = buildWorkingDirectorySuggestions({
      recommendedPaths,
      serverPaths: directorySuggestionsQuery.data ?? [],
      query,
    });
    return paths.map((path) => ({ id: path, label: shortenPath(path), kind: "directory" }));
  }, [directorySuggestionsQuery.data, query, recommendedPaths]);

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

  const displayValue = value.trim() ? shortenPath(value.trim()) : "Select a directory";

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Working directory</Text>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handlePress}
          style={triggerStyle}
          accessibilityRole="button"
          accessibilityLabel={`Select working directory (${displayValue})`}
          testID="schedule-cwd-trigger"
        >
          <Text
            style={value.trim() ? styles.selectTriggerText : styles.selectTriggerPlaceholder}
            numberOfLines={1}
          >
            {displayValue}
          </Text>
          <ChevronDown size={16} color={styles.chevron.color} />
        </Pressable>
      </View>
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        onSearchQueryChange={setQuery}
        searchable
        searchPlaceholder="Type a directory path..."
        emptyText="Start typing a path"
        title="Working directory"
        allowCustomValue
        customValueKind="directory"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Dynamic provider glyph — reads its color off a StyleSheet object so the
 * runtime-resolved component stays compliant without useUnistyles. */
function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

function renderModelTrigger({
  selectedModelLabel,
  onPress,
  disabled,
}: {
  selectedModelLabel: string;
  onPress: () => void;
  disabled: boolean;
  isOpen: boolean;
}): ReactNode {
  return <ModelTrigger label={selectedModelLabel} onPress={onPress} disabled={disabled} />;
}

function ModelTrigger({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}): ReactElement {
  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.selectTrigger,
      (Boolean(hovered) || pressed) && styles.selectTriggerActive,
      disabled && styles.selectTriggerDisabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={triggerStyle}
      accessibilityRole="button"
      accessibilityLabel={`Select model (${label})`}
      testID="schedule-model-trigger"
    >
      <Text style={styles.selectTriggerText} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={16} color={styles.chevron.color} />
    </Pressable>
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
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  // Static color holders read by the dynamic provider icon + chevron (compliant
  // idiom — no useUnistyles in render).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
}));
