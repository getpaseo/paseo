import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Modal,
  TextInput,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";

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
        style={[styles.dropdownControl, disabled && styles.dropdownControlDisabled]}
      >
        <Text
          style={value ? styles.dropdownValue : styles.dropdownPlaceholder}
          numberOfLines={1}
        >
          {value || placeholder}
        </Text>
        <ChevronDown size={16} color={defaultTheme.colors.mutedForeground} />
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
}: SelectFieldProps): ReactElement {
  return (
    <View style={styles.selectFieldContainer}>
      <Pressable
        ref={controlRef}
        onPress={onPress}
        disabled={disabled}
        style={[styles.selectFieldControl, disabled && styles.selectFieldControlDisabled]}
      >
        <View style={styles.selectFieldContent}>
          <Text style={styles.selectFieldLabel}>{label}</Text>
          <Text
            style={value ? styles.selectFieldValue : styles.selectFieldPlaceholder}
            numberOfLines={1}
          >
            {value || placeholder || "Select..."}
          </Text>
        </View>
        <ChevronRight size={20} color={defaultTheme.colors.mutedForeground} />
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

export function DropdownSheet({
  title,
  visible,
  onClose,
  children,
}: DropdownSheetProps): ReactElement {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.dropdownSheetOverlay}>
        <Pressable style={styles.dropdownSheetBackdrop} onPress={onClose} />
        <View style={styles.dropdownSheetContainer}>
          <View style={styles.dropdownSheetHandle} />
          <Text style={styles.dropdownSheetTitle}>{title}</Text>
          <ScrollView
            contentContainerStyle={styles.dropdownSheetScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

interface AdaptiveSelectProps {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  anchorRef: React.RefObject<View | null>;
}

export function AdaptiveSelect({
  title,
  visible,
  onClose,
  children,
  anchorRef,
}: AdaptiveSelectProps): ReactElement {
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
  });

  useEffect(() => {
    if (!visible || isMobile) {
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    anchor.measureInWindow((x, y, width, height) => {
      const verticalOffset = 4;
      const horizontalMargin = 16;
      const maxDropdownHeight = 400;

      let top = y + height + verticalOffset;
      const left = Math.max(horizontalMargin, Math.min(x, windowWidth - width - horizontalMargin));

      if (top + maxDropdownHeight > windowHeight - horizontalMargin) {
        top = y - maxDropdownHeight - verticalOffset;
        if (top < horizontalMargin) {
          top = y + height + verticalOffset;
        }
      }

      setDropdownPosition({ top, left, width });
    });
  }, [visible, isMobile, anchorRef, windowWidth, windowHeight]);

  if (isMobile) {
    return (
      <Modal
        transparent
        animationType="fade"
        visible={visible}
        onRequestClose={onClose}
      >
        <View style={styles.dropdownSheetOverlay}>
          <Pressable style={styles.dropdownSheetBackdrop} onPress={onClose} />
          <View style={styles.dropdownSheetContainer}>
            <View style={styles.dropdownSheetHandle} />
            <Text style={styles.dropdownSheetTitle}>{title}</Text>
            <ScrollView
              contentContainerStyle={styles.dropdownSheetScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.desktopDropdownOverlay}>
        <Pressable style={styles.desktopDropdownBackdrop} onPress={onClose} />
        <View
          style={[
            styles.desktopDropdownContainer,
            {
              position: "absolute",
              top: dropdownPosition.top,
              left: dropdownPosition.left,
              width: dropdownPosition.width,
              minWidth: 200,
            },
          ]}
        >
          <ScrollView
            contentContainerStyle={styles.desktopDropdownScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.desktopDropdownScroll}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
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

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => setIsOpen(false), []);

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
      <AdaptiveSelect
        title="Choose Assistant"
        visible={isOpen}
        onClose={handleClose}
        anchorRef={anchorRef}
      >
        {providerDefinitions.map((definition) => {
          const isSelected = definition.id === selectedProvider;
          return (
            <Pressable
              key={definition.id}
              style={[
                styles.dropdownSheetOption,
                isSelected && styles.dropdownSheetOptionSelected,
              ]}
              onPress={() => {
                onSelect(definition.id);
                handleClose();
              }}
            >
              <Text style={styles.dropdownSheetOptionLabel}>{definition.label}</Text>
              {definition.description ? (
                <Text style={styles.dropdownSheetOptionDescription}>
                  {definition.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </AdaptiveSelect>
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

  const handleOpen = useCallback(() => {
    if (hasOptions) {
      setIsOpen(true);
    }
  }, [hasOptions]);
  const handleClose = useCallback(() => setIsOpen(false), []);

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
        <AdaptiveSelect
          title="Permissions"
          visible={isOpen}
          onClose={handleClose}
          anchorRef={anchorRef}
        >
          {modeOptions.map((mode) => {
            const isSelected = mode.id === selectedMode;
            return (
              <Pressable
                key={mode.id}
                style={[
                  styles.dropdownSheetOption,
                  isSelected && styles.dropdownSheetOptionSelected,
                ]}
                onPress={() => {
                  onSelect(mode.id);
                  handleClose();
                }}
              >
                <Text style={styles.dropdownSheetOptionLabel}>{mode.label}</Text>
                {mode.description ? (
                  <Text style={styles.dropdownSheetOptionDescription}>
                    {mode.description}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </AdaptiveSelect>
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

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => setIsOpen(false), []);

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
      <AdaptiveSelect title="Model" visible={isOpen} onClose={handleClose} anchorRef={anchorRef}>
        <Pressable
          style={styles.dropdownSheetOption}
          onPress={() => {
            onClear();
            handleClose();
          }}
        >
          <Text style={styles.dropdownSheetOptionLabel}>
            Automatic (provider default)
          </Text>
          <Text style={styles.dropdownSheetOptionDescription}>
            Let the assistant pick the recommended model.
          </Text>
        </Pressable>
        {models.map((model) => {
          const isSelected = model.id === selectedModel;
          return (
            <Pressable
              key={model.id}
              style={[
                styles.dropdownSheetOption,
                isSelected && styles.dropdownSheetOptionSelected,
              ]}
              onPress={() => {
                onSelect(model.id);
                handleClose();
              }}
            >
              <Text style={styles.dropdownSheetOptionLabel}>{model.label}</Text>
              {model.description ? (
                <Text style={styles.dropdownSheetOptionDescription}>
                  {model.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          style={styles.dropdownSheetOption}
          onPress={() => {
            onRefresh();
          }}
        >
          <Text style={styles.dropdownSheetOptionLabel}>Refresh models</Text>
          <Text style={styles.dropdownSheetOptionDescription}>
            Request the latest catalog from the provider.
          </Text>
        </Pressable>
        {isLoading ? (
          <View style={styles.dropdownSheetLoading}>
            <ActivityIndicator size="small" color={defaultTheme.colors.foreground} />
          </View>
        ) : null}
      </AdaptiveSelect>
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
  const inputRef = useRef<TextInput | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredPaths = useMemo(() => {
    if (!normalizedSearch) {
      return suggestedPaths;
    }
    return suggestedPaths.filter((path) =>
      path.toLowerCase().includes(normalizedSearch)
    );
  }, [suggestedPaths, normalizedSearch]);

  const hasSuggestedPaths = suggestedPaths.length > 0;
  const hasMatches = filteredPaths.length > 0;
  const sanitizedSearchValue = searchQuery.trim();
  const showCustomOption = sanitizedSearchValue.length > 0;

  const handleSelect = useCallback(
    (path: string) => {
      onSelectPath(path);
      handleClose();
    },
    [handleClose, onSelectPath]
  );

  return (
    <>
      <SelectField
        label="WORKING DIRECTORY"
        value={workingDir}
        placeholder="/path/to/project"
        onPress={handleOpen}
        disabled={disabled}
        errorMessage={errorMessage || undefined}
        helperText={
          hasSuggestedPaths
            ? "Search directories from existing agents or paste a new path."
            : "No agent directories yet - search to add one."
        }
        controlRef={anchorRef}
      />
      <AdaptiveSelect
        title="Working Directory"
        visible={isOpen}
        onClose={handleClose}
        anchorRef={anchorRef}
      >
        <TextInput
          ref={inputRef}
          style={styles.dropdownSearchInput}
          placeholder="/path/to/project"
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!hasSuggestedPaths && !showCustomOption ? (
          <Text style={styles.helperText}>
            We'll suggest directories from agents on this host once they exist.
          </Text>
        ) : null}
        {showCustomOption ? (
          <View style={styles.dropdownSheetList}>
            <Pressable
              key="working-dir-custom-option"
              style={styles.dropdownSheetOption}
              onPress={() => handleSelect(sanitizedSearchValue)}
            >
              <Text style={styles.dropdownSheetOptionLabel} numberOfLines={1}>
                {`Use "${sanitizedSearchValue}"`}
              </Text>
              <Text style={styles.dropdownSheetOptionDescription}>
                Launch the agent in this directory
              </Text>
            </Pressable>
          </View>
        ) : null}
        {hasMatches ? (
          <View style={styles.dropdownSheetList}>
            {filteredPaths.map((path) => {
              const isActive = path === workingDir;
              return (
                <Pressable
                  key={path}
                  style={[
                    styles.dropdownSheetOption,
                    isActive && styles.dropdownSheetOptionSelected,
                  ]}
                  onPress={() => handleSelect(path)}
                >
                  <Text style={styles.dropdownSheetOptionLabel} numberOfLines={1}>
                    {path}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : hasSuggestedPaths ? (
          <Text style={styles.helperText}>
            No agent directories match your search.
          </Text>
        ) : null}
      </AdaptiveSelect>
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
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
  worktreeSlug: string;
  currentBranch: string | null;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  branches: Array<{ name: string; isCurrent: boolean }>;
  status: "idle" | "loading" | "ready" | "error";
  repoError: string | null;
  gitValidationError: string | null;
  baseBranchError: string | null;
}

export function GitOptionsSection({
  useWorktree,
  onUseWorktreeChange,
  worktreeSlug,
  currentBranch,
  baseBranch,
  onBaseBranchChange,
  branches,
  status,
  repoError,
  gitValidationError,
  baseBranchError,
}: GitOptionsSectionProps): ReactElement {
  const isLoading = status === "loading";
  const [isEditingBranch, setIsEditingBranch] = useState(false);
  const [editedBranch, setEditedBranch] = useState(baseBranch);
  const inputRef = useRef<TextInput>(null);

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

  return (
    <View style={styles.gitOptionsContainer}>
      <Pressable
        onPress={() => onUseWorktreeChange(!useWorktree)}
        disabled={isLoading}
        style={[styles.worktreeToggle, isLoading && styles.worktreeToggleDisabled]}
      >
        <View style={[styles.checkbox, useWorktree && styles.checkboxChecked]}>
          {useWorktree ? <View style={styles.checkboxDot} /> : null}
        </View>
        <View style={styles.worktreeToggleContent}>
          <Text style={styles.worktreeToggleLabel}>Create worktree</Text>
          <Text style={styles.worktreeToggleDescription}>
            {isLoading
              ? "Inspecting repository…"
              : useWorktree && worktreeSlug
                ? `Will create: ${worktreeSlug}`
                : currentBranch
                  ? `Run isolated from ${currentBranch}`
                  : "Run in an isolated directory"}
          </Text>
        </View>
      </Pressable>

      {useWorktree ? (
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
                placeholderTextColor={defaultTheme.colors.mutedForeground}
                onSubmitEditing={handleConfirmEdit}
              />
              <Pressable onPress={handleConfirmEdit} hitSlop={8} style={styles.baseBranchIconButton}>
                <Check size={16} color={defaultTheme.colors.palette.green[500]} />
              </Pressable>
              <Pressable onPress={handleCancelEdit} hitSlop={8} style={styles.baseBranchIconButton}>
                <X size={16} color={defaultTheme.colors.mutedForeground} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={handleStartEdit} style={styles.baseBranchValueRow}>
              <Text style={styles.baseBranchValue}>{displayBranch}</Text>
              <Pencil size={14} color={defaultTheme.colors.mutedForeground} />
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
    backgroundColor: theme.colors.background,
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
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
  },
  dropdownSearchInput: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
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
    backgroundColor: theme.colors.card,
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
    marginBottom: theme.spacing[4],
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
    backgroundColor: theme.colors.background,
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
    color: theme.colors.mutedForeground,
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
    color: theme.colors.mutedForeground,
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
    backgroundColor: theme.colors.background,
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
    backgroundColor: theme.colors.background,
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
    color: theme.colors.mutedForeground,
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
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
  },
  gitOptionsContainer: {
    gap: theme.spacing[3],
  },
  worktreeToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.background,
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
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  baseBranchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  baseBranchLabel: {
    color: theme.colors.mutedForeground,
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
    backgroundColor: theme.colors.background,
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
    backgroundColor: theme.colors.popover,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
    maxHeight: 400,
  },
  desktopDropdownScroll: {
    maxHeight: 400,
  },
  desktopDropdownScrollContent: {
    padding: theme.spacing[2],
  },
}));
