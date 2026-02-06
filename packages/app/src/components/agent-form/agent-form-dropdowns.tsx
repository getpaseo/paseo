import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
} from "react-native";
import type { StyleProp, ViewStyle, TextProps } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated from "react-native-reanimated";
import { ChevronDown, ChevronRight, Pencil, Check, X, Bot, Brain, Shield } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { Combobox, ComboboxItem, ComboboxEmpty } from "@/components/ui/combobox";

type DropdownTriggerRenderProps = {
  label: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
  helperText?: string | null;
};

type DropdownTriggerRenderer = (props: DropdownTriggerRenderProps) => ReactNode;

interface DropdownFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
  helperText?: string | null;
  renderTrigger?: DropdownTriggerRenderer;
  testID?: string;
}

export function DropdownField({
  label,
  value,
  placeholder,
  onPress,
  disabled,
  errorMessage,
  warningMessage,
  helperText,
  renderTrigger,
  testID,
}: DropdownFieldProps): ReactElement {
  if (renderTrigger) {
    return (
      <>
        {renderTrigger({
          label,
          value,
          placeholder,
          onPress,
          disabled,
          errorMessage,
          warningMessage,
          helperText,
        })}
      </>
    );
  }

  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        testID={testID}
        style={[styles.dropdownControl, disabled && styles.dropdownControlDisabled]}
      >
        <Text
          style={value ? styles.dropdownValue : styles.dropdownPlaceholder}
          numberOfLines={1}
        >
          {value || placeholder}
        </Text>
        <ChevronDown size={16} color={defaultTheme.colors.foregroundMuted} />
      </Pressable>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {warningMessage ? <Text style={styles.warningText}>{warningMessage}</Text> : null}
      {!errorMessage && helperText ? (
        <Text style={styles.helperText}>{helperText}</Text>
      ) : null}
    </View>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onPress: () => void;
  disabled?: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
  helperText?: string | null;
  controlRef?: React.RefObject<View | null>;
  valueEllipsizeMode?: "head" | "middle" | "tail" | "clip";
  testID?: string;
}

export function SelectField({
  label,
  value,
  placeholder,
  onPress,
  disabled,
  errorMessage,
  warningMessage,
  helperText,
  controlRef,
  valueEllipsizeMode,
  testID,
}: SelectFieldProps): ReactElement {
  const getWebKey = useCallback((event: unknown): string | null => {
    if (!event || typeof event !== "object") return null;
    const eventWithNative = event as { nativeEvent?: unknown; key?: unknown };
    if (typeof eventWithNative.key === "string") return eventWithNative.key;
    const nativeEvent = eventWithNative.nativeEvent as { key?: unknown } | undefined;
    return typeof nativeEvent?.key === "string" ? nativeEvent.key : null;
  }, []);

  const preventWebDefault = useCallback((event: unknown) => {
    if (!event || typeof event !== "object") return;
    const candidate = event as { preventDefault?: unknown };
    if (typeof candidate.preventDefault === "function") {
      candidate.preventDefault();
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: unknown) => {
      if (Platform.OS !== "web") return;
      const key = getWebKey(event);
      if (key === "Enter" || key === " ") {
        preventWebDefault(event);
        onPress();
      }
    },
    [getWebKey, onPress, preventWebDefault]
  );

  const normalizedValue = (value ?? "").trim();
  const normalizedPlaceholder = (placeholder ?? "").trim();
  const hasConcreteValue =
    normalizedValue.length > 0 &&
    (normalizedPlaceholder.length === 0 || normalizedValue !== normalizedPlaceholder);
  const displayText = hasConcreteValue
    ? normalizedValue
    : (normalizedPlaceholder || "Select...");

  return (
    <View style={styles.selectFieldContainer}>
      <Pressable
        ref={controlRef}
        onPress={onPress}
        // @ts-ignore - tabIndex is web-only
        tabIndex={0}
        accessibilityRole="button"
        // @ts-ignore - onKeyDown is web-only
        onKeyDown={handleKeyDown}
        disabled={disabled}
        testID={testID}
        style={[styles.selectFieldControl, disabled && styles.selectFieldControlDisabled]}
      >
        <View style={styles.selectFieldContent}>
          <Text style={styles.selectFieldLabel}>{label}</Text>
          <Text
            style={value ? styles.selectFieldValue : styles.selectFieldPlaceholder}
            numberOfLines={1}
            ellipsizeMode={valueEllipsizeMode ?? "tail"}
          >
            {value || placeholder || "Select..."}
          </Text>
        </View>
        <ChevronRight size={20} color={defaultTheme.colors.foregroundMuted} />
      </Pressable>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {warningMessage ? <Text style={styles.warningText}>{warningMessage}</Text> : null}
      {!errorMessage && !warningMessage && helperText ? (
        <Text style={styles.helperText}>{helperText}</Text>
      ) : null}
    </View>
  );
}

interface DropdownSheetProps {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

function DropdownSheetBackground({ style }: BottomSheetBackgroundProps) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[style, styles.bottomSheetBackground]}
    />
  );
}

export function DropdownSheet({
  title,
  visible,
  onClose,
  children,
}: DropdownSheetProps): ReactElement {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ["60%", "90%"], []);

  const handleClose = useCallback(() => {
    bottomSheetRef.current?.dismiss();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [visible]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        onClose();
      }
    },
    [onClose]
  );

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.45}
      />
    ),
    []
  );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      index={0}
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      backgroundComponent={DropdownSheetBackground}
      handleIndicatorStyle={styles.bottomSheetHandle}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
    >
      <View style={styles.bottomSheetHeader}>
        <Text style={styles.dropdownSheetTitle}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
          onPress={handleClose}
          hitSlop={10}
          testID="dropdown-sheet-close"
        >
          <X size={18} color={defaultTheme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <BottomSheetScrollView
        contentContainerStyle={styles.dropdownSheetScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

// Re-export ComboboxItem as SelectOption for backwards compatibility
const SelectOption = ComboboxItem;

interface ComboSelectOption {
  id: string;
  label: string;
  description?: string;
}

interface ComboSelectProps {
  label: string;
  title: string;
  value: string;
  options: ComboSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  allowCustomValue?: boolean;
  isLoading?: boolean;
  onSelect: (id: string) => void;
  icon?: ReactElement;
  showLabel?: boolean;
}

export function ComboSelect({
  label,
  title,
  value,
  options,
  placeholder,
  disabled,
  allowCustomValue = false,
  isLoading,
  onSelect,
  icon,
  showLabel = true,
}: ComboSelectProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const selectedOption = options.find((opt) => opt.id === value);
  const displayValue = selectedOption?.label ?? (value || "");

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  return (
    <>
      <FormSelectTrigger
        label={label}
        value={displayValue}
        placeholder={placeholder}
        onPress={handleOpen}
        disabled={disabled}
        isLoading={isLoading}
        controlRef={anchorRef}
        icon={icon}
        showLabel={showLabel}
      />
      <Combobox
        options={options}
        value={value}
        onSelect={onSelect}
        searchPlaceholder={`Search ${label.toLowerCase()}...`}
        allowCustomValue={allowCustomValue}
        title={title}
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
      />
    </>
  );
}

interface CompactSelectFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onPress: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  controlRef?: React.RefObject<View | null>;
  icon?: ReactElement;
  showLabel?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  valueEllipsizeMode?: TextProps["ellipsizeMode"];
  testID?: string;
}

export function FormSelectTrigger({
  label,
  value,
  placeholder,
  onPress,
  disabled,
  isLoading,
  controlRef,
  icon,
  showLabel = true,
  containerStyle,
  valueEllipsizeMode,
  testID,
}: CompactSelectFieldProps): ReactElement {
  const getWebKey = useCallback((event: unknown): string | null => {
    if (!event || typeof event !== "object") return null;
    const eventWithNative = event as { nativeEvent?: unknown; key?: unknown };
    if (typeof eventWithNative.key === "string") return eventWithNative.key;
    const nativeEvent = eventWithNative.nativeEvent as { key?: unknown } | undefined;
    return typeof nativeEvent?.key === "string" ? nativeEvent.key : null;
  }, []);

  const preventWebDefault = useCallback((event: unknown) => {
    if (!event || typeof event !== "object") return;
    const candidate = event as { preventDefault?: unknown };
    if (typeof candidate.preventDefault === "function") {
      candidate.preventDefault();
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: unknown) => {
      if (Platform.OS !== "web") return;
      const key = getWebKey(event);
      if (key === "Enter" || key === " ") {
        preventWebDefault(event);
        onPress();
      }
    },
    [getWebKey, onPress, preventWebDefault]
  );
  const normalizedValue = (value ?? "").trim();
  const normalizedPlaceholder = (placeholder ?? "").trim();
  const hasConcreteValue =
    normalizedValue.length > 0 &&
    (normalizedPlaceholder.length === 0 || normalizedValue !== normalizedPlaceholder);
  const displayText = hasConcreteValue
    ? normalizedValue
    : (normalizedPlaceholder || "Select...");

  return (
    <Pressable
      ref={controlRef}
      onPress={onPress}
      testID={testID}
      // @ts-ignore - tabIndex is web-only
      tabIndex={0}
      accessibilityRole="button"
      // @ts-ignore - onKeyDown is web-only
      onKeyDown={handleKeyDown}
      disabled={disabled}
      style={[
        styles.compactSelectControl,
        !showLabel && styles.compactSelectControlInline,
        containerStyle,
        disabled && styles.compactSelectControlDisabled,
      ]}
    >
      {icon ? <View style={styles.compactSelectLeading}>{icon}</View> : null}
      <View style={styles.compactSelectValueContainer}>
        {showLabel ? (
          <Text style={styles.compactSelectLabel}>{label}</Text>
        ) : null}
        {isLoading ? (
          <ActivityIndicator size="small" color={defaultTheme.colors.foregroundMuted} />
        ) : (
          <Text
            style={hasConcreteValue ? styles.compactSelectValue : styles.compactSelectPlaceholder}
            numberOfLines={1}
            ellipsizeMode={valueEllipsizeMode}
          >
            {displayText}
          </Text>
        )}
      </View>
      <ChevronDown size={16} color={defaultTheme.colors.foregroundMuted} />
    </Pressable>
  );
}

interface AgentConfigRowProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  onSelectProvider: (provider: AgentProvider) => void;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  isModelLoading: boolean;
  onSelectModel: (modelId: string) => void;
  disabled?: boolean;
}

export function AgentConfigRow({
  providerDefinitions,
  selectedProvider,
  onSelectProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  isModelLoading,
  onSelectModel,
  disabled,
}: AgentConfigRowProps): ReactElement {
  const providerOptions: ComboSelectOption[] = useMemo(
    () =>
      providerDefinitions.map((def) => ({
        id: def.id,
        label: def.label,
      })),
    [providerDefinitions]
  );

  const modeSelectOptions: ComboSelectOption[] = useMemo(() => {
    if (modeOptions.length === 0) {
      return [{ id: "", label: "Default" }];
    }
    return modeOptions.map((mode) => ({
      id: mode.id,
      label: mode.label,
    }));
  }, [modeOptions]);

  const modelSelectOptions: ComboSelectOption[] = useMemo(() => {
    const opts: ComboSelectOption[] = [
      { id: "", label: "Auto" },
    ];
    for (const model of models) {
      opts.push({
        id: model.id,
        label: model.label,
      });
    }
    return opts;
  }, [models]);

  const effectiveSelectedMode = selectedMode || (modeOptions.length > 0 ? modeOptions[0]?.id : "");

  return (
    <View style={styles.agentConfigRow}>
      <View style={styles.agentConfigColumn}>
        <ComboSelect
          label="Provider"
          title="Select provider"
          value={selectedProvider}
          options={providerOptions}
          placeholder="Select..."
          disabled={disabled}
          onSelect={onSelectProvider}
          icon={<Bot size={16} color={defaultTheme.colors.foregroundMuted} />}
          showLabel={false}
        />
      </View>
      <View style={styles.agentConfigColumn}>
        <ComboSelect
          label="Model"
          title="Select model"
          value={selectedModel}
          options={modelSelectOptions}
          placeholder="Auto"
          disabled={disabled}
          isLoading={isModelLoading}
          onSelect={onSelectModel}
          icon={<Brain size={16} color={defaultTheme.colors.foregroundMuted} />}
          showLabel={false}
        />
      </View>
      <View style={styles.agentConfigColumn}>
        <ComboSelect
          label="Mode"
          title="Select mode"
          value={effectiveSelectedMode}
          options={modeSelectOptions}
          placeholder="Default"
          disabled={disabled || modeOptions.length === 0}
          onSelect={onSelectMode}
          icon={<Shield size={16} color={defaultTheme.colors.foregroundMuted} />}
          showLabel={false}
        />
      </View>
    </View>
  );
}

interface AssistantDropdownProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  disabled: boolean;
  onSelect: (provider: AgentProvider) => void;
}

export function AssistantDropdown({
  providerDefinitions,
  selectedProvider,
  disabled,
  onSelect,
}: AssistantDropdownProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const selectedDefinition = providerDefinitions.find(
    (definition) => definition.id === selectedProvider
  );

  const options = useMemo(
    () =>
      providerDefinitions.map((def) => ({
        id: def.id,
        label: def.label,
      })),
    [providerDefinitions]
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  return (
    <>
      <SelectField
        label="AGENT"
        value={selectedDefinition?.label ?? ""}
        placeholder="Select assistant"
        onPress={handleOpen}
        disabled={disabled}
        controlRef={anchorRef}
      />
      <Combobox
        options={options}
        value={selectedProvider}
        onSelect={(id) => onSelect(id as AgentProvider)}
        title="Choose assistant"
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
      />
    </>
  );
}

interface PermissionsDropdownProps {
  modeOptions: AgentMode[];
  selectedMode: string;
  disabled: boolean;
  onSelect: (modeId: string) => void;
}

export function PermissionsDropdown({
  modeOptions,
  selectedMode,
  disabled,
  onSelect,
}: PermissionsDropdownProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const hasOptions = modeOptions.length > 0;
  const selectedModeLabel = hasOptions
    ? modeOptions.find((mode) => mode.id === selectedMode)?.label ??
      modeOptions[0]?.label ??
      "Default"
    : "Automatic";

  const options = useMemo(
    () =>
      modeOptions.map((mode) => ({
        id: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    [modeOptions]
  );

  const handleOpen = useCallback(() => {
    if (hasOptions) {
      setIsOpen(true);
    }
  }, [hasOptions]);
  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  return (
    <>
      <SelectField
        label="PERMISSIONS"
        value={selectedModeLabel}
        placeholder={hasOptions ? "Select permissions" : "Automatic"}
        onPress={handleOpen}
        disabled={disabled || !hasOptions}
        helperText={
          hasOptions
            ? undefined
            : "This assistant does not expose selectable permissions."
        }
        controlRef={anchorRef}
      />
      {hasOptions ? (
        <Combobox
          options={options}
          value={selectedMode}
          onSelect={onSelect}
          title="Permissions"
          open={isOpen}
          onOpenChange={handleOpenChange}
          anchorRef={anchorRef}
        />
      ) : null}
    </>
  );
}

interface ModelDropdownProps {
  models: AgentModelDefinition[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (modelId: string) => void;
  onClear: () => void;
  onRefresh: () => void;
}

export function ModelDropdown({
  models,
  selectedModel,
  isLoading,
  error,
  onSelect,
  onClear,
  onRefresh,
}: ModelDropdownProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const selectedLabel = selectedModel
    ? models.find((model) => model.id === selectedModel)?.label ?? selectedModel
    : "Automatic";
  const placeholder = isLoading && models.length === 0 ? "Loading..." : "Automatic";
  const helperText = error
    ? undefined
    : isLoading
      ? "Fetching available models..."
      : models.length === 0
        ? "This assistant did not expose selectable models."
        : undefined;

  const options = useMemo(() => {
    const opts: ComboSelectOption[] = [
      {
        id: "",
        label: "Automatic (provider default)",
        description: "Let the assistant pick the recommended model.",
      },
    ];
    for (const model of models) {
      opts.push({
        id: model.id,
        label: model.label,
        description: model.description,
      });
    }
    return opts;
  }, [models]);

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);
  const handleSelect = useCallback(
    (id: string) => {
      if (id === "") {
        onClear();
      } else {
        onSelect(id);
      }
    },
    [onClear, onSelect]
  );

  return (
    <>
      <SelectField
        label="MODEL"
        value={selectedLabel}
        placeholder={placeholder}
        onPress={handleOpen}
        disabled={false}
        errorMessage={error ?? undefined}
        helperText={helperText}
        controlRef={anchorRef}
      />
      <Combobox
        options={options}
        value={selectedModel}
        onSelect={handleSelect}
        title="Model"
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
      />
    </>
  );
}

interface WorkingDirectoryDropdownProps {
  workingDir: string;
  errorMessage: string;
  disabled: boolean;
  suggestedPaths: string[];
  onSelectPath: (value: string) => void;
}

export function WorkingDirectoryDropdown({
  workingDir,
  errorMessage,
  disabled,
  suggestedPaths,
  onSelectPath,
}: WorkingDirectoryDropdownProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const options = useMemo(
    () => suggestedPaths.map((path) => ({ id: path, label: path })),
    [suggestedPaths]
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  const emptyText = suggestedPaths.length > 0
    ? "No agent directories match your search."
    : "We'll suggest directories from agents on this host once they exist.";

  return (
    <>
      <SelectField
        label="WORKING DIRECTORY"
        value={workingDir}
        placeholder="/path/to/project"
        onPress={handleOpen}
        disabled={disabled}
        errorMessage={errorMessage || undefined}
        valueEllipsizeMode="middle"
        controlRef={anchorRef}
        testID="working-directory-select"
      />
      <Combobox
        options={options}
        value={workingDir}
        onSelect={onSelectPath}
        searchPlaceholder="/path/to/project"
        emptyText={emptyText}
        allowCustomValue
        customValuePrefix="Use"
        customValueDescription="Launch the agent in this directory"
        title="Working directory"
        open={isOpen}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
      />
    </>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({
  label,
  description,
  value,
  onToggle,
  disabled,
}: ToggleRowProps): ReactElement {
  return (
    <Pressable
      onPress={() => {
        if (!disabled) {
          onToggle(!value);
        }
      }}
      style={[styles.toggleRow, disabled && styles.toggleRowDisabled]}
    >
      <View
        style={[
          styles.checkbox,
          value && styles.checkboxChecked,
          disabled && styles.checkboxDisabled,
        ]}
      >
        {value ? <View style={styles.checkboxDot} /> : null}
      </View>
      <View style={styles.toggleTextContainer}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description ? (
          <Text style={styles.helperText}>{description}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export interface GitOptionsSectionProps {
  worktreeMode: "none" | "create" | "attach";
  onWorktreeModeChange: (value: "none" | "create" | "attach") => void;
  worktreeSlug: string;
  currentBranch: string | null;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  status: "idle" | "loading" | "ready" | "error";
  repoError: string | null;
  gitValidationError: string | null;
  baseBranchError: string | null;
  worktreeOptions: Array<{ path: string; label: string }>;
  selectedWorktreePath: string;
  worktreeOptionsStatus: "idle" | "loading" | "ready" | "error";
  worktreeOptionsError: string | null;
  attachWorktreeError: string | null;
  onSelectWorktreePath: (path: string) => void;
}

export function GitOptionsSection({
  worktreeMode,
  onWorktreeModeChange,
  worktreeSlug,
  currentBranch,
  baseBranch,
  onBaseBranchChange,
  status,
  repoError,
  gitValidationError,
  baseBranchError,
  worktreeOptions,
  selectedWorktreePath,
  worktreeOptionsStatus,
  worktreeOptionsError,
  attachWorktreeError,
  onSelectWorktreePath,
}: GitOptionsSectionProps): ReactElement {
  const isLoading = status === "loading";
  const isCreateMode = worktreeMode === "create";
  const isAttachMode = worktreeMode === "attach";
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [editedBranch, setEditedBranch] = useState(baseBranch);
  const inputRef = useRef<TextInput>(null);
  const [isWorktreeSheetOpen, setIsWorktreeSheetOpen] = useState(false);

  useEffect(() => {
    setEditedBranch(baseBranch);
  }, [baseBranch]);

  useEffect(() => {
    if (isEditingBranch) {
      inputRef.current?.focus();
    }
  }, [isEditingBranch]);

  const handleStartEdit = useCallback(() => {
    setEditedBranch(baseBranch);
    setIsEditingBranch(true);
  }, [baseBranch]);

  const handleConfirmEdit = useCallback(() => {
    const trimmed = editedBranch.trim();
    if (trimmed) {
      onBaseBranchChange(trimmed);
    }
    setIsEditingBranch(false);
  }, [editedBranch, onBaseBranchChange]);

  const handleCancelEdit = useCallback(() => {
    setEditedBranch(baseBranch);
    setIsEditingBranch(false);
  }, [baseBranch]);

  const displayBranch = baseBranch || currentBranch || "HEAD";
  const selectedWorktreeLabel =
    worktreeOptions.find((option) => option.path === selectedWorktreePath)?.label ?? "";
  const worktreeHelperText =
    worktreeOptionsStatus === "loading"
      ? "Loading worktrees..."
      : worktreeOptions.length === 0
        ? "No worktrees found"
        : null;

  return (
    <View style={styles.gitOptionsContainer}>
      <Pressable
        testID="worktree-create-toggle"
        onPress={() =>
          onWorktreeModeChange(isCreateMode ? "none" : "create")
        }
        disabled={isLoading}
        style={[styles.worktreeToggle, isLoading && styles.worktreeToggleDisabled]}
      >
        <View style={[styles.checkbox, isCreateMode && styles.checkboxChecked]}>
          {isCreateMode ? <View style={styles.checkboxDot} /> : null}
        </View>
        <View style={styles.worktreeToggleContent}>
          <Text style={styles.worktreeToggleLabel}>Create worktree</Text>
          <Text style={styles.worktreeToggleDescription}>
            {isLoading
              ? "Inspecting repository…"
              : isCreateMode
                ? `Will create: ${worktreeSlug || "preparing…"}`
                : currentBranch
                  ? `Run isolated from ${currentBranch}`
                  : "Run in an isolated directory"}
          </Text>
        </View>
      </Pressable>

      <Pressable
        testID="worktree-attach-toggle"
        onPress={() =>
          onWorktreeModeChange(isAttachMode ? "none" : "attach")
        }
        disabled={isLoading}
        style={[styles.worktreeToggle, isLoading && styles.worktreeToggleDisabled]}
      >
        <View style={[styles.checkbox, isAttachMode && styles.checkboxChecked]}>
          {isAttachMode ? <View style={styles.checkboxDot} /> : null}
        </View>
        <View style={styles.worktreeToggleContent}>
          <Text style={styles.worktreeToggleLabel}>Attach to existing worktree</Text>
          <Text style={styles.worktreeToggleDescription}>
            {isLoading ? "Inspecting repository…" : "Pick a Paseo worktree by branch"}
          </Text>
        </View>
      </Pressable>

      {isAttachMode ? (
        <>
          <SelectField
            label="Worktree"
            value={selectedWorktreeLabel}
            placeholder="Select a worktree"
            onPress={() => setIsWorktreeSheetOpen(true)}
            disabled={isLoading || worktreeOptionsStatus === "loading"}
            helperText={worktreeHelperText}
            errorMessage={attachWorktreeError || worktreeOptionsError}
            testID="worktree-attach-picker"
          />
          <DropdownSheet
            title="Select worktree"
            visible={isWorktreeSheetOpen}
            onClose={() => setIsWorktreeSheetOpen(false)}
          >
            {worktreeOptions.map((option, index) => (
              <SelectOption
                key={option.path}
                label={option.label}
                selected={option.path === selectedWorktreePath}
                testID={`worktree-attach-option-${index}`}
                onPress={() => {
                  onSelectWorktreePath(option.path);
                  setIsWorktreeSheetOpen(false);
                }}
              />
            ))}
          </DropdownSheet>
        </>
      ) : null}

      {isCreateMode ? (
        <View style={styles.baseBranchRow}>
          <Text style={styles.baseBranchLabel}>Base branch:</Text>
          {isEditingBranch ? (
            <View style={styles.baseBranchEditRow}>
              <TextInput
                ref={inputRef}
                style={styles.baseBranchInput}
                value={editedBranch}
                onChangeText={setEditedBranch}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="branch name"
                placeholderTextColor={defaultTheme.colors.foregroundMuted}
                onSubmitEditing={handleConfirmEdit}
              />
              <Pressable onPress={handleConfirmEdit} hitSlop={8} style={styles.baseBranchIconButton}>
                <Check size={16} color={defaultTheme.colors.palette.green[500]} />
              </Pressable>
              <Pressable onPress={handleCancelEdit} hitSlop={8} style={styles.baseBranchIconButton}>
                <X size={16} color={defaultTheme.colors.foregroundMuted} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={handleStartEdit} style={styles.baseBranchValueRow}>
              <Text style={styles.baseBranchValue}>{displayBranch}</Text>
              <Pencil size={14} color={defaultTheme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
      ) : null}

      {baseBranchError ? (
        <Text style={styles.errorText}>{baseBranchError}</Text>
      ) : null}

      {repoError ? (
        <Text style={styles.errorText}>{repoError}</Text>
      ) : null}

      {gitValidationError ? (
        <Text style={styles.errorText}>{gitValidationError}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  formSection: {
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  dropdownControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  dropdownControlDisabled: {
    opacity: theme.opacity[50],
  },
  dropdownValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  dropdownPlaceholder: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  bottomSheetBackground: {
    backgroundColor: theme.colors.surface2,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
  },
  bottomSheetHandle: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  bottomSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[2],
  },
  dropdownSheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  dropdownSheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.palette.gray[900],
    opacity: 0.45,
  },
  dropdownSheetContainer: {
    backgroundColor: theme.colors.surface2,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6] + theme.spacing[2],
    maxHeight: 560,
    width: "100%",
  },
  dropdownSheetHandle: {
    width: 56,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
    alignSelf: "center",
    marginBottom: theme.spacing[3],
  },
  dropdownSheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  dropdownSheetScrollContent: {
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[1],
  },
  dropdownSheetList: {
    marginTop: theme.spacing[3],
  },
  dropdownSheetOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    marginBottom: theme.spacing[2],
  },
  dropdownSheetOptionSelected: {
    borderColor: theme.colors.palette.blue[400],
    backgroundColor: "rgba(59, 130, 246, 0.18)",
  },
  dropdownSheetOptionLabel: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  dropdownSheetOptionDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  dropdownSheetLoading: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  warningText: {
    color: theme.colors.palette.orange[500],
    fontSize: theme.fontSize.sm,
  },
  helperText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  selectorColumn: {
    flex: 1,
    gap: theme.spacing[3],
  },
  selectorColumnFull: {
    width: "100%",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  toggleRowDisabled: {
    opacity: theme.opacity[50],
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.palette.blue[500],
  },
  checkboxDisabled: {
    borderColor: theme.colors.border,
  },
  checkboxDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.white,
  },
  toggleTextContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  toggleLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  dropdownLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  selectFieldContainer: {
    gap: theme.spacing[2],
  },
  selectFieldControl: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  selectFieldControlDisabled: {
    opacity: theme.opacity[50],
  },
  selectFieldContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  selectFieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  selectFieldValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  selectFieldPlaceholder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  gitOptionsContainer: {
    gap: theme.spacing[3],
  },
  worktreeToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  worktreeToggleDisabled: {
    opacity: theme.opacity[50],
  },
  worktreeToggleContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  worktreeToggleLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  worktreeToggleDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  baseBranchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  baseBranchLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  baseBranchValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  baseBranchValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  baseBranchEditRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  baseBranchInput: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  baseBranchIconButton: {
    padding: theme.spacing[1],
  },
  desktopDropdownOverlay: {
    flex: 1,
  },
  desktopDropdownBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  desktopDropdownContainer: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
    maxHeight: 400,
    overflow: "hidden",
  },
  desktopDropdownScroll: {
    maxHeight: 400,
  },
  desktopDropdownScrollContent: {
    paddingVertical: theme.spacing[1],
  },
  agentConfigRow: {
    flexDirection: {
      xs: "column",
      md: "row",
    },
    gap: theme.spacing[2],
  },
  agentConfigColumn: {
    flex: 1,
  },
  compactSelectControl: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[1],
  },
  compactSelectControlInline: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  compactSelectControlDisabled: {
    opacity: theme.opacity[50],
  },
  compactSelectTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  compactSelectLeading: {
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  compactSelectValueContainer: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  compactSelectLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  compactSelectValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  compactSelectPlaceholder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
