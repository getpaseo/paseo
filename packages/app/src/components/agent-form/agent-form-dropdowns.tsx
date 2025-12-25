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
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
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

interface AssistantDropdownProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  disabled: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (provider: AgentProvider) => void;
  label?: string;
  placeholder?: string;
  sheetTitle?: string;
  renderTrigger?: DropdownTriggerRenderer;
  wrapInContainer?: boolean;
}

export function AssistantDropdown({
  providerDefinitions,
  selectedProvider,
  disabled,
  isOpen,
  onOpen,
  onClose,
  onSelect,
  label = "Assistant",
  placeholder = "Select assistant",
  sheetTitle = "Choose Assistant",
  renderTrigger,
  wrapInContainer = true,
}: AssistantDropdownProps): ReactElement {
  const selectedDefinition = providerDefinitions.find(
    (definition) => definition.id === selectedProvider
  );
  const field = (
    <>
      <DropdownField
        label={label}
        value={selectedDefinition?.label ?? ""}
        placeholder={placeholder}
        onPress={onOpen}
        disabled={disabled}
        renderTrigger={renderTrigger}
      />
      <DropdownSheet title={sheetTitle} visible={isOpen} onClose={onClose}>
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
                onClose();
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
      </DropdownSheet>
    </>
  );

  if (!wrapInContainer) {
    return <>{field}</>;
  }

  return <View style={styles.selectorColumn}>{field}</View>;
}

interface PermissionsDropdownProps {
  modeOptions: AgentMode[];
  selectedMode: string;
  disabled: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (modeId: string) => void;
  label?: string;
  placeholder?: string;
  sheetTitle?: string;
  renderTrigger?: DropdownTriggerRenderer;
  wrapInContainer?: boolean;
}

export function PermissionsDropdown({
  modeOptions,
  selectedMode,
  disabled,
  isOpen,
  onOpen,
  onClose,
  onSelect,
  label = "Permissions",
  placeholder,
  sheetTitle = "Permissions",
  renderTrigger,
  wrapInContainer = true,
}: PermissionsDropdownProps): ReactElement {
  const hasOptions = modeOptions.length > 0;
  const selectedModeLabel = hasOptions
    ? modeOptions.find((mode) => mode.id === selectedMode)?.label ??
      modeOptions[0]?.label ??
      "Default"
    : "Automatic";
  const placeholderLabel = hasOptions
    ? placeholder ?? "Select permissions"
    : "Automatic";
  const field = (
    <>
      <DropdownField
        label={label}
        value={selectedModeLabel}
        placeholder={placeholderLabel}
        onPress={hasOptions ? onOpen : () => {}}
        disabled={disabled || !hasOptions}
        helperText={
          hasOptions
            ? undefined
            : "This assistant does not expose selectable permissions."
        }
        renderTrigger={renderTrigger}
      />
      {hasOptions ? (
        <DropdownSheet title={sheetTitle} visible={isOpen} onClose={onClose}>
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
                  onClose();
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
        </DropdownSheet>
      ) : null}
    </>
  );

  if (!wrapInContainer) {
    return <>{field}</>;
  }

  return <View style={[styles.selectorColumn, styles.selectorColumnFull]}>{field}</View>;
}

interface ModelDropdownProps {
  models: AgentModelDefinition[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  onClear: () => void;
  onRefresh: () => void;
  label?: string;
  renderTrigger?: DropdownTriggerRenderer;
  wrapInContainer?: boolean;
}

export function ModelDropdown({
  models,
  selectedModel,
  isLoading,
  error,
  isOpen,
  onOpen,
  onClose,
  onSelect,
  onClear,
  onRefresh,
  label = "Model",
  renderTrigger,
  wrapInContainer = true,
}: ModelDropdownProps): ReactElement {
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

  const field = (
    <>
      <DropdownField
        label={label}
        value={selectedLabel}
        placeholder={placeholder}
        onPress={onOpen}
        disabled={false}
        errorMessage={error ?? undefined}
        helperText={helperText}
        renderTrigger={renderTrigger}
      />
      <DropdownSheet title="Model" visible={isOpen} onClose={onClose}>
        <Pressable
          style={styles.dropdownSheetOption}
          onPress={() => {
            onClear();
            onClose();
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
                onClose();
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
      </DropdownSheet>
    </>
  );

  if (!wrapInContainer) {
    return <>{field}</>;
  }

  return <View style={styles.selectorColumn}>{field}</View>;
}

interface WorkingDirectoryDropdownProps {
  workingDir: string;
  errorMessage: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  disabled: boolean;
  suggestedPaths: string[];
  onSelectPath: (value: string) => void;
  label?: string;
  renderTrigger?: DropdownTriggerRenderer;
  wrapInContainer?: boolean;
}

export function WorkingDirectoryDropdown({
  workingDir,
  errorMessage,
  isOpen,
  onOpen,
  onClose,
  disabled,
  suggestedPaths,
  onSelectPath,
  label = "Working Directory",
  renderTrigger,
  wrapInContainer = true,
}: WorkingDirectoryDropdownProps): ReactElement {
  const inputRef = useRef<TextInput | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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
      onClose();
    },
    [onClose, onSelectPath]
  );

  const field = (
    <>
      <DropdownField
        label={label}
        value={workingDir}
        placeholder="/path/to/project"
        onPress={onOpen}
        disabled={disabled}
        errorMessage={errorMessage || undefined}
        helperText={
          hasSuggestedPaths
            ? "Search directories from existing agents or paste a new path."
            : "No agent directories yet - search to add one."
        }
        renderTrigger={renderTrigger}
      />
      <DropdownSheet title="Working Directory" visible={isOpen} onClose={onClose}>
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
      </DropdownSheet>
    </>
  );

  if (!wrapInContainer) {
    return <>{field}</>;
  }

  return <View style={styles.formSection}>{field}</View>;
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
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  branches: Array<{ name: string; isCurrent: boolean }>;
  status: "idle" | "loading" | "ready" | "error";
  repoError: string | null;
  helperText?: string | null;
  warning: string | null;
  createNewBranch: boolean;
  onToggleCreateNewBranch: (value: boolean) => void;
  branchName: string;
  onBranchNameChange: (value: string) => void;
  createWorktree: boolean;
  onToggleCreateWorktree: (value: boolean) => void;
  worktreeSlug: string;
  onWorktreeSlugChange: (value: string) => void;
  gitValidationError: string | null;
  isGitDisabled?: boolean;
  isBaseDropdownOpen: boolean;
  onToggleBaseDropdown: () => void;
  onCloseDropdown: () => void;
}

export function GitOptionsSection({
  baseBranch,
  onBaseBranchChange,
  branches,
  status,
  repoError,
  helperText,
  warning,
  createNewBranch,
  onToggleCreateNewBranch,
  branchName,
  onBranchNameChange,
  createWorktree,
  onToggleCreateWorktree,
  worktreeSlug,
  onWorktreeSlugChange,
  gitValidationError,
  isGitDisabled,
  isBaseDropdownOpen,
  onToggleBaseDropdown,
  onCloseDropdown,
}: GitOptionsSectionProps): ReactElement {
  const [branchSearch, setBranchSearch] = useState("");
  const branchFilter = branchSearch.trim().toLowerCase();
  const filteredBranches =
    branchFilter.length === 0
      ? branches
      : branches.filter((branch) =>
          branch.name.toLowerCase().includes(branchFilter)
        );
  const maxVisible = 30;
  const currentBranchLabel =
    branches.find((branch) => branch.isCurrent)?.name ?? "";
  const baseInputRef = useRef<TextInput | null>(null);
  const gitInputsDisabled = Boolean(isGitDisabled) || status === "loading";

  useEffect(() => {
    if (isBaseDropdownOpen) {
      setBranchSearch("");
      baseInputRef.current?.focus();
    }
  }, [isBaseDropdownOpen]);

  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>Git Setup</Text>
      <Text style={styles.helperText}>
        Choose a base branch, then optionally create a feature branch or
        isolated worktree.
      </Text>

      <DropdownField
        label="Base Branch"
        value={baseBranch}
        placeholder={currentBranchLabel || "main"}
        onPress={onToggleBaseDropdown}
        disabled={gitInputsDisabled}
        errorMessage={repoError}
        warningMessage={!gitValidationError && !isGitDisabled ? warning : null}
        helperText={
          helperText ??
          (status === "loading"
            ? "Inspecting repository…"
            : "Search existing branches, then tap to select.")
        }
      />
      <DropdownSheet
        title="Base Branch"
        visible={isBaseDropdownOpen}
        onClose={onCloseDropdown}
      >
        <TextInput
          ref={baseInputRef}
          style={styles.dropdownSearchInput}
          placeholder={currentBranchLabel || "main"}
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={branchSearch}
          onChangeText={setBranchSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {status === "loading" ? (
          <View style={styles.dropdownLoading}>
            <ActivityIndicator color={defaultTheme.colors.mutedForeground} />
            <Text style={styles.helperText}>Inspecting repository…</Text>
          </View>
        ) : filteredBranches.length === 0 ? (
          <Text style={styles.helperText}>
            {branchFilter.length === 0
              ? "No branches detected yet."
              : "No branches match your search."}
          </Text>
        ) : (
          <View style={styles.dropdownSheetList}>
            {filteredBranches.slice(0, maxVisible).map((branch) => {
              const isActive = branch.name === baseBranch;
              return (
                <Pressable
                  key={branch.name}
                  style={[
                    styles.dropdownSheetOption,
                    isActive && styles.dropdownSheetOptionSelected,
                  ]}
                  onPress={() => {
                    onBaseBranchChange(branch.name);
                    onCloseDropdown();
                  }}
                >
                  <Text style={styles.dropdownSheetOptionLabel}>
                    {branch.name}
                    {branch.isCurrent ? "  (current)" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {filteredBranches.length > maxVisible ? (
          <Text style={styles.helperText}>
            Showing first {maxVisible} matches. Keep typing to narrow it down.
          </Text>
        ) : null}
      </DropdownSheet>

      <ToggleRow
        label="New Branch"
        description="Create a feature branch before launching the agent"
        value={createNewBranch}
        onToggle={onToggleCreateNewBranch}
        disabled={isGitDisabled}
      />
      {createNewBranch ? (
        <TextInput
          style={styles.input}
          placeholder="feature-branch-name"
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={branchName}
          onChangeText={onBranchNameChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      <ToggleRow
        label="Create Worktree"
        description="Use an isolated directory so your current branch stays untouched"
        value={createWorktree}
        onToggle={onToggleCreateWorktree}
        disabled={isGitDisabled}
      />
      {createWorktree ? (
        <TextInput
          style={styles.input}
          placeholder={branchName || "feature-worktree"}
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={worktreeSlug}
          onChangeText={onWorktreeSlugChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
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
}));
