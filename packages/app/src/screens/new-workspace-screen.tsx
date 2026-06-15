import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNameId } from "mnemonic-id";
import { useQuery } from "@tanstack/react-query";
import { MAX_SLUG_LENGTH } from "@getpaseo/protocol/branch-slug";
import { Check, ChevronDown, Folder, GitBranch, GitPullRequest, X } from "lucide-react-native";
import { Composer } from "@/composer";
import { DraftAgentModeControl } from "@/composer/agent-controls/mode-control";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { FileDropZone } from "@/components/file-drop-zone";
import { ProjectIconView } from "@/components/project-icon-view";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { HEADER_INNER_HEIGHT, MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useGithubSearchQuery } from "@/git/use-github-search-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import {
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  useHostProjects,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import type { ImageAttachment, MessagePayload } from "@/composer/types";
import type { AgentAttachment, GitHubSearchItem } from "@getpaseo/protocol/messages";
import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } from "./new-workspace-empty";
import {
  createNewBranchPlaceholderName,
  resolveNewBranchError,
  resolveRequestedNewBranchSlug,
} from "./new-workspace-branch-name";
import { resolveNewWorkspaceCheckoutRequest, type PickerItem } from "./new-workspace-picker-item";
import {
  computePickerOptionData,
  pickerItemOptionId,
  pickerItemTriggerLabel,
  type PickerOptionData,
} from "./new-workspace-picker-options";
import { findCheckoutHintPrAttachment, syncPickerPrAttachment } from "./new-workspace-picker-state";
import { NewWorkspaceRefPickerOptionItem } from "./new-workspace-ref-picker-option-item";

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
}

interface ProjectOptionData {
  options: ComboboxOptionType[];
  projectByOptionId: Map<string, HostProjectListItem>;
}

interface PickerSelection {
  item: PickerItem;
  attachedPrNumber: number | null;
}

interface NewWorkspaceProjectPickerInput {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
}

interface NewWorkspaceProjectPickerState {
  projects: HostProjectListItem[];
  selectedProject: HostProjectListItem | null;
  selectedSourceDirectory: string | null;
  selectedDisplayName: string;
  projectPickerOptions: ComboboxOptionType[];
  projectByOptionId: Map<string, HostProjectListItem>;
  selectedProjectOptionId: string;
  projectTriggerLabel: string;
  handleSelectProjectOption: (id: string) => void;
}

const PROJECT_OPTION_PREFIX = "project:";

function RefPickerBadgeContent({
  selectedItem,
  triggerLabel,
  iconColor,
  iconSize,
}: {
  selectedItem: PickerItem | null;
  triggerLabel: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <>
      <View style={styles.badgeIconBox}>
        {selectedItem?.kind === "github-pr" ? (
          <GitPullRequest size={iconSize} color={iconColor} />
        ) : (
          <GitBranch size={iconSize} color={iconColor} />
        )}
      </View>
      <Text style={styles.badgeText} numberOfLines={1}>
        {triggerLabel}
      </Text>
      <ChevronDown size={iconSize} color={iconColor} />
    </>
  );
}

function RefPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  selectedItem,
  triggerLabel,
  accessibilityLabel,
  tooltipLabel,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  selectedItem: PickerItem | null;
  triggerLabel: string;
  accessibilityLabel: string;
  tooltipLabel: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          ref={pickerAnchorRef}
          testID="new-workspace-ref-picker-trigger"
          onPress={onPress}
          disabled={disabled}
          style={badgePressableStyle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <RefPickerBadgeContent
            selectedItem={selectedItem}
            triggerLabel={triggerLabel}
            iconColor={iconColor}
            iconSize={iconSize}
          />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ProjectPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  label,
  projectKey,
  iconDataUri,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  label: string;
  projectKey: string | null;
  iconDataUri: string | null;
  iconColor: string;
  iconSize: number;
}) {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(label);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase() || "?";
  return (
    <Tooltip>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          ref={pickerAnchorRef}
          testID="new-workspace-project-picker-trigger"
          onPress={onPress}
          disabled={disabled}
          style={badgePressableStyle}
          accessibilityRole="button"
          accessibilityLabel="Workspace project"
        >
          <View style={styles.badgeIconBox}>
            {projectKey ? (
              <ProjectIconView
                iconDataUri={iconDataUri}
                initial={placeholderInitial}
                projectKey={projectKey}
                imageStyle={styles.badgeProjectIcon}
                fallbackStyle={styles.badgeProjectIconFallback}
                textStyle={styles.badgeProjectIconFallbackText}
              />
            ) : (
              <Folder size={iconSize} color={iconColor} />
            )}
          </View>
          <Text style={styles.badgeText} numberOfLines={1}>
            {label}
          </Text>
          <ChevronDown size={iconSize} color={iconColor} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>Choose project</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function CheckoutHintBadge({
  label,
  acceptLabel,
  dismissLabel,
  onAccept,
  onDismiss,
  iconColor,
  iconSize,
}: {
  label: string;
  acceptLabel: string;
  dismissLabel: string;
  onAccept: () => void;
  onDismiss: () => void;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <View style={styles.checkoutHintBadge}>
      <Text style={styles.badgeText} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        testID="new-workspace-checkout-hint-accept"
        onPress={onAccept}
        style={styles.checkoutHintAction}
        accessibilityRole="button"
        accessibilityLabel={acceptLabel}
      >
        <Check size={iconSize} color={iconColor} />
      </Pressable>
      <Pressable
        testID="new-workspace-checkout-hint-dismiss"
        onPress={onDismiss}
        style={styles.checkoutHintAction}
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
      >
        <X size={iconSize} color={iconColor} />
      </Pressable>
    </View>
  );
}

function ProjectOptionItem({
  testID,
  projectKey,
  iconDataUri,
  label,
  description,
  selected,
  active,
  disabled,
  onPress,
}: {
  testID: string;
  projectKey: string;
  iconDataUri: string | null;
  label: string;
  description: string | undefined;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(label);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase() || "?";
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        <ProjectIconView
          iconDataUri={iconDataUri}
          initial={placeholderInitial}
          projectKey={projectKey}
          imageStyle={styles.projectOptionIcon}
          fallbackStyle={styles.projectOptionIconFallback}
          textStyle={styles.projectOptionIconFallbackText}
        />
      </View>
    ),
    [iconDataUri, placeholderInitial, projectKey],
  );

  return (
    <ComboboxItem
      testID={testID}
      label={label}
      description={description}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function projectOptionId(projectId: string): string {
  return `${PROJECT_OPTION_PREFIX}${projectId}`;
}

function computeProjectOptionData(projects: readonly HostProjectListItem[]): ProjectOptionData {
  const projectByOptionId = new Map<string, HostProjectListItem>();
  const options = projects.map((project) => {
    const id = projectOptionId(project.projectKey);
    projectByOptionId.set(id, project);
    return { id, label: project.projectName };
  });
  return { options, projectByOptionId };
}

function useNewWorkspaceProjectPicker({
  serverId,
  sourceDirectory,
  projectId,
  displayName: displayNameProp,
}: NewWorkspaceProjectPickerInput): NewWorkspaceProjectPickerState {
  const [manualProjectKey, setManualProjectKey] = useState<string | null>(null);
  const displayName = displayNameProp?.trim() ?? "";
  const projects = useHostProjects(serverId || null);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const lastWorkspaceServerId = lastWorkspaceSelection?.serverId === serverId ? serverId : null;
  const lastWorkspaceId =
    lastWorkspaceSelection?.serverId === serverId ? lastWorkspaceSelection.workspaceId : null;
  const lastWorkspace = useWorkspace(lastWorkspaceServerId, lastWorkspaceId);
  const routeProject = useMemo(
    () =>
      hostProjectFromRoute({
        serverId,
        projectId,
        displayName,
        sourceDirectory,
      }),
    [displayName, projectId, serverId, sourceDirectory],
  );
  const lastActiveProject = useMemo(
    () => hostProjectFromWorkspace({ serverId, workspace: lastWorkspace }),
    [lastWorkspace, serverId],
  );
  const initialProject = useMemo(
    () =>
      resolveInitialWorktreeProject({
        routeProject,
        lastActiveProject,
        projects,
      }),
    [lastActiveProject, projects, routeProject],
  );
  const worktreeProjects = useMemo(
    () => projects.filter((project) => project.canCreateWorktree),
    [projects],
  );

  const selectedProjectKey = manualProjectKey ?? initialProject?.projectKey ?? null;

  const selectedProject = useMemo(
    () =>
      resolveSelectedHostProject({
        selectedProjectKey,
        projects,
        routeProject,
        lastActiveProject,
      }),
    [lastActiveProject, projects, routeProject, selectedProjectKey],
  );
  const { options: projectPickerOptions, projectByOptionId }: ProjectOptionData = useMemo(
    () => computeProjectOptionData(worktreeProjects),
    [worktreeProjects],
  );
  const handleSelectProjectOption = useCallback(
    (id: string) => {
      const project = projectByOptionId.get(id);
      if (!project?.canCreateWorktree) return;
      setManualProjectKey(project.projectKey);
    },
    [projectByOptionId],
  );

  return {
    projects,
    selectedProject,
    selectedSourceDirectory: selectedProject?.iconWorkingDir ?? null,
    selectedDisplayName: selectedProject?.projectName ?? displayName,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId: selectedProject ? projectOptionId(selectedProject.projectKey) : "",
    projectTriggerLabel: selectedProject?.projectName ?? "Choose project",
    handleSelectProjectOption,
  };
}

function getContentStyle(input: { isCompact: boolean; insetBottom: number }) {
  if (input.isCompact) {
    return [styles.content, styles.contentCompact, { paddingBottom: input.insetBottom }];
  }
  return [styles.content, styles.contentCentered];
}

function getSelectedPickerItem(selection: PickerSelection | null): PickerItem | null {
  if (!selection) return null;
  return selection.item;
}

function normalizeBranchDetails(
  data:
    | {
        branchDetails?: Array<{ name: string; committerDate: number }>;
        branches?: string[];
      }
    | undefined,
): Array<{ name: string; committerDate: number }> {
  const details = data?.branchDetails;
  if (details && details.length > 0) return details;
  const names = data?.branches ?? [];
  return names.map((name) => ({ name, committerDate: 0 }));
}

function focusNewBranchInputOnSelect(
  item: PickerItem,
  inputRef: React.RefObject<TextInput | null>,
): void {
  if (item.kind !== "new-branch") {
    return;
  }
  setTimeout(() => inputRef.current?.focus(), 0);
}

function updateNewBranchPlaceholderOnSelect(
  item: PickerItem,
  setPlaceholderName: React.Dispatch<React.SetStateAction<string>>,
): void {
  if (item.kind !== "new-branch") {
    return;
  }
  setPlaceholderName((current) => createNewBranchPlaceholderName({ previousName: current }));
}

function getPrPickerItems(input: {
  githubFeaturesEnabled: boolean;
  items: GitHubSearchItem[] | undefined;
}): GitHubSearchItem[] {
  if (!input.githubFeaturesEnabled) {
    return [];
  }
  return input.items ?? [];
}

function getRefPickerEmptyText(input: {
  branchSuggestionsFetching: boolean;
  githubPrsFetching: boolean;
  searchingLabel: string;
  emptyLabel: string;
}): string {
  if (input.branchSuggestionsFetching || input.githubPrsFetching) {
    return input.searchingLabel;
  }
  return input.emptyLabel;
}

function NewBranchNameField({
  visible,
  isPending,
  inputRef,
  value,
  placeholder,
  error,
  onChangeText,
}: {
  visible: boolean;
  isPending: boolean;
  inputRef: React.RefObject<TextInput | null>;
  value: string;
  placeholder: string;
  error: string | null;
  onChangeText: (value: string) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const containerStyle = useMemo(
    () => [styles.newBranchInputContainer, isPending && styles.badgeDisabled],
    [isPending],
  );

  if (!visible) {
    return null;
  }

  return (
    <View style={styles.newBranchField}>
      <View style={containerStyle}>
        <View style={styles.badgeIconBox}>
          <GitBranch size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        </View>
        <TextInput
          ref={inputRef}
          accessibilityLabel={t("newWorkspace.newBranch.accessibilityLabel")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          maxLength={MAX_SLUG_LENGTH}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          spellCheck={false}
          style={styles.newBranchInput}
          testID="new-workspace-new-branch-input"
          value={value}
        />
      </View>
      {error ? <Text style={styles.newBranchErrorText}>{error}</Text> : null}
    </View>
  );
}

interface SubmitDraftInput {
  serverId: string;
  draftKey: string;
  workspaceId: string;
  workspaceDirectory: string;
  text: string;
  attachments: ComposerAttachment[];
  provider: AgentProvider;
  composerState: NonNullable<ReturnType<typeof useAgentInputDraft>["composerState"]>;
}

async function createAndMergeWorkspace(input: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  createInput: Parameters<
    NonNullable<ReturnType<typeof useHostRuntimeClient>>["createPaseoWorktree"]
  >[0];
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const payload = await input.client.createPaseoWorktree(input.createInput);
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? input.createFailedMessage);
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceForInitialMerge = input.createInput.firstAgentContext
    ? {
        ...normalizedWorkspace,
        status: "running" as const,
        statusEnteredAt: new Date(),
      }
    : normalizedWorkspace;
  input.mergeWorkspaces(input.serverId, [workspaceForInitialMerge]);
  return normalizedWorkspace;
}

interface CreateChatAgentInput {
  payload: MessagePayload;
  composerState: ReturnType<typeof useAgentInputDraft>["composerState"];
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  serverId: string;
  draftKey: string;
  labels: {
    composerStateRequired: string;
    selectModel: string;
  };
}

async function runCreateChatAgent(input: CreateChatAgentInput): Promise<void> {
  const { payload, composerState, ensureWorkspace, serverId, draftKey } = input;
  const { text, attachments, cwd } = payload;
  if (!composerState) {
    throw new Error(input.labels.composerStateRequired);
  }
  const provider = composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.labels.selectModel);
  }
  const { attachments: reviewAttachments } = splitComposerAttachmentsForSubmit(attachments);
  const ensuredWorkspace = await ensureWorkspace({
    cwd,
    prompt: text,
    attachments: reviewAttachments,
  });
  submitWorkspaceDraft({
    serverId,
    draftKey,
    workspaceId: ensuredWorkspace.id,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    text,
    attachments,
    provider,
    composerState,
  });
}

function buildComposerConfig(input: {
  serverId: string;
  isConnected: boolean;
  workspaceDirectory: string | null;
  sourceDirectory: string | null;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, isConnected, workspaceDirectory, sourceDirectory } = input;
  const workingDir = workspaceDirectory || sourceDirectory || undefined;
  return {
    initialServerId: serverId || null,
    initialValues: workingDir ? { workingDir } : undefined,
    isVisible: true,
    onlineServerIds: isConnected && serverId ? [serverId] : [],
    lockedWorkingDir: workingDir,
  };
}

function collectAttachedPrNumbers(attachments: ReadonlyArray<UserComposerAttachment>): Set<number> {
  const numbers = new Set<number>();
  for (const attachment of attachments) {
    if (attachment.kind === "github_pr") {
      numbers.add(attachment.item.number);
    }
  }
  return numbers;
}

function pruneDismissedCheckoutHintPrNumbers(
  dismissed: ReadonlySet<number>,
  attached: ReadonlySet<number>,
): ReadonlySet<number> {
  let changed = false;
  const next = new Set<number>();
  for (const prNumber of dismissed) {
    if (attached.has(prNumber)) {
      next.add(prNumber);
    } else {
      changed = true;
    }
  }
  return changed ? next : dismissed;
}

function useCheckoutHintDismissals(attachments: ReadonlyArray<UserComposerAttachment>) {
  const [dismissedPrNumbers, setDismissedPrNumbers] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const attachedPrNumbers = useMemo(() => collectAttachedPrNumbers(attachments), [attachments]);

  useEffect(() => {
    setDismissedPrNumbers((current) =>
      pruneDismissedCheckoutHintPrNumbers(current, attachedPrNumbers),
    );
  }, [attachedPrNumbers]);

  return [dismissedPrNumbers, setDismissedPrNumbers] as const;
}

function submitWorkspaceDraft(input: SubmitDraftInput): void {
  const {
    serverId,
    draftKey,
    workspaceId,
    workspaceDirectory,
    text,
    attachments,
    provider,
    composerState,
  } = input;
  const draftId = generateDraftId();
  const clientMessageId = generateMessageId();
  const timestamp = Date.now();
  const wirePayload = splitComposerAttachmentsForSubmit(attachments);
  useCreateFlowStore.getState().setPending({
    serverId,
    draftId,
    workspaceId,
    agentId: null,
    clientMessageId,
    text: text.trim(),
    timestamp,
    ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
    ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
  });
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId,
    workspaceId,
    draftId,
    text: text.trim(),
    attachments,
    cwd: workspaceDirectory,
    provider,
    clientMessageId,
    timestamp,
    ...(composerState.selectedMode !== "" ? { modeId: composerState.selectedMode } : {}),
    ...(composerState.effectiveModelId ? { model: composerState.effectiveModelId } : {}),
    ...(composerState.effectiveThinkingOptionId
      ? { thinkingOptionId: composerState.effectiveThinkingOptionId }
      : {}),
    ...(composerState.featureValues ? { featureValues: composerState.featureValues } : {}),
    allowEmptyText: true,
  });
  navigateToPreparedWorkspaceTab({
    serverId,
    workspaceId,
    target: { kind: "draft", draftId },
  });
  useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "sent" });
}

export function NewWorkspaceScreen({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
}: NewWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | null>(null);
  const [manualPickerSelection, setManualPickerSelection] = useState<PickerSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchPlaceholderName, setNewBranchPlaceholderName] = useState(
    createNewBranchPlaceholderName,
  );
  const pickerAnchorRef = useRef<View>(null);
  const projectPickerAnchorRef = useRef<View>(null);
  const newBranchInputRef = useRef<TextInput>(null);

  useEffect(() => {
    const trimmed = pickerSearchQuery.trim();
    const timer = setTimeout(() => setDebouncedPickerSearchQuery(trimmed), 180);
    return () => clearTimeout(timer);
  }, [pickerSearchQuery]);

  const workspace = createdWorkspace;
  const isPending = pendingAction !== null;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const {
    projects,
    selectedProject,
    selectedSourceDirectory,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId,
    projectTriggerLabel,
    handleSelectProjectOption: selectProjectOption,
  } = useNewWorkspaceProjectPicker({
    serverId,
    sourceDirectory: sourceDirectoryProp,
    projectId,
    displayName: displayNameProp,
  });
  const projectIconDataByProjectKey = useProjectIconDataByProjectKey({
    serverId,
    projects,
  });
  const draftKey = `new-workspace:${serverId}:${selectedSourceDirectory ?? "choose-project"}`;
  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: buildComposerConfig({
      serverId,
      isConnected,
      workspaceDirectory: workspace?.workspaceDirectory ?? null,
      sourceDirectory: selectedSourceDirectory,
    }),
  });
  const composerState = chatDraft.composerState;
  const [dismissedCheckoutHintPrNumbers, setDismissedCheckoutHintPrNumbers] =
    useCheckoutHintDismissals(chatDraft.attachments);

  const selectedItem = getSelectedPickerItem(manualPickerSelection);

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error(t("newWorkspace.errors.hostDisconnected"));
    }
    return client;
  }, [client, isConnected, t]);

  const clientReady = isConnected && Boolean(client);
  const hasSelectedSourceDirectory = selectedSourceDirectory !== null;
  const pickerQueryEnabled = pickerOpen && clientReady && hasSelectedSourceDirectory;

  const checkoutStatusQuery = useQuery({
    queryKey: ["checkout-status", serverId, selectedSourceDirectory],
    queryFn: async () => {
      if (!selectedSourceDirectory) {
        throw new Error("Choose a project");
      }
      const connectedClient = withConnectedClient();
      return connectedClient.getCheckoutStatus(selectedSourceDirectory);
    },
    enabled: clientReady && hasSelectedSourceDirectory,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const currentBranch = checkoutStatusQuery.data?.currentBranch ?? null;
  const isNewBranchSelected = selectedItem?.kind === "new-branch";
  const requestedNewBranchSlug = useMemo(
    () =>
      resolveRequestedNewBranchSlug({
        selectedItem,
        newBranchName,
        placeholderName: newBranchPlaceholderName,
      }),
    [newBranchName, newBranchPlaceholderName, selectedItem],
  );
  const newBranchError = useMemo(() => {
    return resolveNewBranchError({
      rawName: newBranchName,
      requestedSlug: requestedNewBranchSlug,
      isNewBranchSelected,
      invalidLabel: t("newWorkspace.newBranch.invalid"),
    });
  }, [isNewBranchSelected, newBranchName, requestedNewBranchSlug, t]);

  const branchSuggestionsQuery = useQuery({
    queryKey: ["branch-suggestions", serverId, selectedSourceDirectory, debouncedPickerSearchQuery],
    queryFn: async () => {
      if (!selectedSourceDirectory) {
        throw new Error("Choose a project");
      }
      const connectedClient = withConnectedClient();
      return connectedClient.getBranchSuggestions({
        cwd: selectedSourceDirectory,
        query: debouncedPickerSearchQuery || undefined,
        limit: 20,
      });
    },
    enabled: pickerQueryEnabled,
    staleTime: 15_000,
  });

  const githubPrSearchQuery = useGithubSearchQuery({
    client,
    serverId,
    cwd: selectedSourceDirectory ?? "",
    query: debouncedPickerSearchQuery,
    kinds: ["github-pr"],
    enabled: pickerQueryEnabled,
  });

  const branchDetails = useMemo(
    () => normalizeBranchDetails(branchSuggestionsQuery.data),
    [branchSuggestionsQuery.data],
  );
  const githubFeaturesEnabled = githubPrSearchQuery.data?.githubFeaturesEnabled !== false;
  const prItems: GitHubSearchItem[] = useMemo(
    () =>
      getPrPickerItems({
        githubFeaturesEnabled,
        items: githubPrSearchQuery.data?.items,
      }),
    [githubFeaturesEnabled, githubPrSearchQuery.data?.items],
  );
  const pickerItemLabels = useMemo(
    () => ({
      newBranch: t("newWorkspace.newBranch.placeholder"),
    }),
    [t],
  );

  const { options, itemById }: PickerOptionData = useMemo(
    () =>
      computePickerOptionData({
        branchDetails,
        prItems,
        newBranchLabel: pickerItemLabels.newBranch,
      }),
    [branchDetails, pickerItemLabels.newBranch, prItems],
  );
  const triggerLabel = useMemo(() => {
    if (selectedItem) return pickerItemTriggerLabel(selectedItem, pickerItemLabels);
    return currentBranch ?? "main";
  }, [currentBranch, pickerItemLabels, selectedItem]);

  const selectedOptionId = useMemo(() => {
    if (!selectedItem) return "";
    return pickerItemOptionId(selectedItem);
  }, [selectedItem]);
  const refPickerIntoBaseLabel = useCallback(
    (baseRef: string) => t("newWorkspace.refPicker.intoBase", { baseRef }),
    [t],
  );
  const selectPickerItem = useCallback(
    (item: PickerItem) => {
      const next = syncPickerPrAttachment({
        attachments: chatDraft.attachments,
        previousPickerPrNumber: manualPickerSelection?.attachedPrNumber ?? null,
        item,
      });

      setManualPickerSelection({
        item,
        attachedPrNumber: next.attachedPrNumber,
      });
      if (next.attachments !== chatDraft.attachments) {
        chatDraft.setAttachments(next.attachments);
      }
      setPickerOpen(false);
      updateNewBranchPlaceholderOnSelect(item, setNewBranchPlaceholderName);
      focusNewBranchInputOnSelect(item, newBranchInputRef);
    },
    [chatDraft, manualPickerSelection?.attachedPrNumber],
  );

  const handleSelectOption = useCallback(
    (id: string) => {
      const item = itemById.get(id);
      if (!item) return;
      selectPickerItem(item);
    },
    [itemById, selectPickerItem],
  );

  const handleSelectProjectOption = useCallback(
    (id: string) => {
      const project = projectByOptionId.get(id);
      if (!project?.canCreateWorktree) return;
      selectProjectOption(id);
      setProjectPickerOpen(false);
      setManualPickerSelection(null);
    },
    [projectByOptionId, selectProjectOption],
  );

  const checkoutHintPrAttachment = useMemo(
    () =>
      findCheckoutHintPrAttachment({
        attachments: chatDraft.attachments,
        selectedItem,
        dismissedPrNumbers: dismissedCheckoutHintPrNumbers,
      }),
    [chatDraft.attachments, dismissedCheckoutHintPrNumbers, selectedItem],
  );

  const acceptCheckoutHint = useCallback(() => {
    if (!checkoutHintPrAttachment) return;
    selectPickerItem({
      kind: "github-pr",
      item: checkoutHintPrAttachment.item,
    });
  }, [checkoutHintPrAttachment, selectPickerItem]);

  const dismissCheckoutHint = useCallback(() => {
    if (!checkoutHintPrAttachment) return;
    const prNumber = checkoutHintPrAttachment.item.number;
    setDismissedCheckoutHintPrNumbers((current) => {
      if (current.has(prNumber)) return current;
      const next = new Set(current);
      next.add(prNumber);
      return next;
    });
  }, [checkoutHintPrAttachment, setDismissedCheckoutHintPrNumbers]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
  }, []);

  const openProjectPicker = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleClearDraft = useCallback(() => {
    // No-op: screen navigates away on success, text should stay for retry on error
  }, []);

  const badgePressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.badge,
      Boolean(hovered) && !isPending && styles.badgeHovered,
      pressed && !isPending && styles.badgePressed,
      isPending && styles.badgeDisabled,
    ],
    [isPending],
  );
  const handlePickerOpenChange = useCallback((nextOpen: boolean) => {
    setPickerOpen(nextOpen);
    if (!nextOpen) {
      setPickerSearchQuery("");
    }
  }, []);

  const handleProjectPickerOpenChange = useCallback((nextOpen: boolean) => {
    setProjectPickerOpen(nextOpen);
  }, []);

  const handleNewBranchNameChange = useCallback((value: string) => {
    setNewBranchName(value);
  }, []);

  const buildCreateWorktreeInput = useCallback(
    (input: {
      cwd: string;
      prompt: string;
      attachments: AgentAttachment[];
    }): CreatePaseoWorktreeInput => {
      if (!selectedProject) {
        throw new Error("Choose a project");
      }
      if (newBranchError) {
        throw new Error(newBranchError);
      }
      const checkoutResolution = resolveNewWorkspaceCheckoutRequest({
        selectedItem,
        currentBranch,
        newBranchSlug: requestedNewBranchSlug,
      });
      const trimmedPrompt = input.prompt.trim();
      const hasFirstAgentContext = trimmedPrompt.length > 0 || input.attachments.length > 0;

      return {
        cwd: selectedProject.iconWorkingDir,
        projectId: selectedProject.projectKey,
        worktreeSlug: checkoutResolution.worktreeSlug ?? createNameId(),
        ...(hasFirstAgentContext
          ? {
              firstAgentContext: {
                ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
                ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
              },
            }
          : {}),
        ...checkoutResolution.checkoutRequest,
      };
    },
    [currentBranch, newBranchError, requestedNewBranchSlug, selectedItem, selectedProject],
  );

  const ensureWorkspace = useCallback(
    async (input: { cwd: string; prompt: string; attachments: AgentAttachment[] }) => {
      if (createdWorkspace) {
        return createdWorkspace;
      }
      const normalizedWorkspace = await createAndMergeWorkspace({
        client: withConnectedClient(),
        createInput: buildCreateWorktreeInput(input),
        mergeWorkspaces,
        serverId,
        createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
      });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [buildCreateWorktreeInput, createdWorkspace, mergeWorkspaces, serverId, t, withConnectedClient],
  );

  const handleSubmitNewWorkspace = useCallback(
    async (payload: MessagePayload) => {
      try {
        setErrorMessage(null);
        await composerState?.persistFormPreferences();
        if (isEmptyWorkspaceSubmission(payload)) {
          setPendingAction("empty");
          await runCreateEmptyWorkspace({
            payload,
            ensureWorkspace,
            serverId,
            navigate: navigateToWorkspace,
          });
          return;
        }

        setPendingAction("chat");
        await runCreateChatAgent({
          payload,
          composerState,
          ensureWorkspace,
          serverId,
          draftKey,
          labels: {
            composerStateRequired: t("newWorkspace.errors.composerStateRequired"),
            selectModel: t("newWorkspace.errors.selectModel"),
          },
        });
      } catch (error) {
        const message = toErrorMessage(error);
        setPendingAction(null);
        setErrorMessage(message);
        toast.error(message);
      }
    },
    [composerState, draftKey, ensureWorkspace, serverId, t, toast],
  );

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);
  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const renderPickerOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const item = itemById.get(option.id);
      if (!item) return <View key={option.id} />;

      return (
        <NewWorkspaceRefPickerOptionItem
          item={item}
          labels={pickerItemLabels}
          selected={selected}
          active={active}
          disabled={isPending}
          onPress={onPress}
          intoBaseLabel={refPickerIntoBaseLabel}
          iconColor={theme.colors.foregroundMuted}
          iconSize={theme.iconSize.sm}
        />
      );
    },
    [
      isPending,
      itemById,
      pickerItemLabels,
      refPickerIntoBaseLabel,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
    ],
  );

  const renderProjectOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const project = projectByOptionId.get(option.id);
      if (!project) return <View key={option.id} />;

      return (
        <ProjectOptionItem
          testID={`new-workspace-project-picker-option-${project.projectKey}`}
          projectKey={project.projectKey}
          iconDataUri={projectIconDataByProjectKey.get(project.projectKey) ?? null}
          label={project.projectName}
          description={project.iconWorkingDir}
          selected={selected}
          active={active}
          disabled={isPending || !project.canCreateWorktree}
          onPress={onPress}
        />
      );
    },
    [isPending, projectByOptionId, projectIconDataByProjectKey],
  );

  const contentStyle = useMemo(
    () => getContentStyle({ isCompact, insetBottom: insets.bottom }),
    [isCompact, insets.bottom],
  );

  const { style: composerKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const centeredStyle = useMemo(
    () => [styles.centered, composerKeyboardStyle],
    [composerKeyboardStyle],
  );

  const agentControlsWithDisabled = useMemo(
    () =>
      composerState
        ? {
            ...composerState.agentControls,
            disabled: isPending,
          }
        : undefined,
    [composerState, isPending],
  );

  const pickerEmptyText = getRefPickerEmptyText({
    branchSuggestionsFetching: branchSuggestionsQuery.isFetching,
    githubPrsFetching: githubPrSearchQuery.isFetching,
    searchingLabel: t("newWorkspace.refPicker.searching"),
    emptyLabel: t("newWorkspace.refPicker.noMatchingRefs"),
  });

  const composerFooter = useMemo(
    () => (
      <View testID="new-workspace-ref-picker-row" style={styles.optionsRow}>
        <View>
          <ProjectPickerTrigger
            pickerAnchorRef={projectPickerAnchorRef}
            onPress={openProjectPicker}
            disabled={isPending || projectPickerOptions.length === 0}
            badgePressableStyle={badgePressableStyle}
            label={projectTriggerLabel}
            projectKey={selectedProject?.projectKey ?? null}
            iconDataUri={
              selectedProject
                ? (projectIconDataByProjectKey.get(selectedProject.projectKey) ?? null)
                : null
            }
            iconColor={theme.colors.foregroundMuted}
            iconSize={theme.iconSize.sm}
          />
          <Combobox
            options={projectPickerOptions}
            value={selectedProjectOptionId}
            onSelect={handleSelectProjectOption}
            searchable
            searchPlaceholder="Search projects"
            title="Project"
            open={projectPickerOpen}
            onOpenChange={handleProjectPickerOpenChange}
            desktopPlacement="bottom-start"
            anchorRef={projectPickerAnchorRef}
            emptyText="No projects available."
            renderOption={renderProjectOption}
          />
        </View>
        <View>
          <RefPickerTrigger
            pickerAnchorRef={pickerAnchorRef}
            onPress={openPicker}
            disabled={isPending || !selectedSourceDirectory}
            badgePressableStyle={badgePressableStyle}
            selectedItem={selectedItem}
            triggerLabel={triggerLabel}
            accessibilityLabel={t("newWorkspace.refPicker.startingRef")}
            tooltipLabel={t("newWorkspace.refPicker.chooseStart")}
            iconColor={theme.colors.foregroundMuted}
            iconSize={theme.iconSize.sm}
          />
          <Combobox
            options={options}
            value={selectedOptionId}
            onSelect={handleSelectOption}
            searchable
            searchPlaceholder={t("newWorkspace.refPicker.searchPlaceholder")}
            title={t("newWorkspace.refPicker.title")}
            open={pickerOpen}
            onOpenChange={handlePickerOpenChange}
            onSearchQueryChange={setPickerSearchQuery}
            desktopPlacement="bottom-start"
            anchorRef={pickerAnchorRef}
            emptyText={pickerEmptyText}
            renderOption={renderPickerOption}
          />
        </View>
        <NewBranchNameField
          visible={isNewBranchSelected}
          isPending={isPending}
          inputRef={newBranchInputRef}
          value={newBranchName}
          placeholder={newBranchPlaceholderName}
          error={newBranchError}
          onChangeText={handleNewBranchNameChange}
        />
        {agentControlsWithDisabled ? (
          <DraftAgentModeControl placement="footer" {...agentControlsWithDisabled} />
        ) : null}
        {checkoutHintPrAttachment ? (
          <CheckoutHintBadge
            label={t("newWorkspace.refPicker.checkoutHint", {
              number: checkoutHintPrAttachment.item.number,
            })}
            acceptLabel={t("newWorkspace.refPicker.checkoutPr", {
              number: checkoutHintPrAttachment.item.number,
            })}
            dismissLabel={t("newWorkspace.refPicker.dismissCheckoutHint", {
              number: checkoutHintPrAttachment.item.number,
            })}
            onAccept={acceptCheckoutHint}
            onDismiss={dismissCheckoutHint}
            iconColor={theme.colors.foregroundMuted}
            iconSize={theme.iconSize.sm}
          />
        ) : null}
      </View>
    ),
    [
      acceptCheckoutHint,
      badgePressableStyle,
      checkoutHintPrAttachment,
      dismissCheckoutHint,
      handlePickerOpenChange,
      handleProjectPickerOpenChange,
      handleNewBranchNameChange,
      handleSelectOption,
      handleSelectProjectOption,
      isNewBranchSelected,
      isPending,
      newBranchError,
      newBranchName,
      newBranchPlaceholderName,
      openPicker,
      openProjectPicker,
      options,
      pickerEmptyText,
      pickerOpen,
      projectPickerOpen,
      projectPickerOptions,
      projectTriggerLabel,
      projectIconDataByProjectKey,
      renderPickerOption,
      renderProjectOption,
      selectedItem,
      selectedOptionId,
      selectedProject,
      selectedProjectOptionId,
      selectedSourceDirectory,
      setPickerSearchQuery,
      agentControlsWithDisabled,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
      triggerLabel,
    ],
  );
  const screenHeaderLeft = useMemo(() => <SidebarMenuToggle />, []);

  return (
    <FileDropZone onFilesDropped={handleFilesDropped}>
      <View style={styles.container}>
        <ScreenHeader left={screenHeaderLeft} borderless />
        <View style={contentStyle}>
          <TitlebarDragRegion />
          <ReanimatedAnimated.View style={centeredStyle}>
            <View style={styles.composerTitleContainer}>
              <Text style={styles.composerTitle}>{t("newWorkspace.title")}</Text>
            </View>
            <Composer
              agentId={draftKey}
              serverId={serverId}
              isPaneFocused={true}
              onSubmitMessage={handleSubmitNewWorkspace}
              allowEmptySubmit={true}
              submitButtonAccessibilityLabel={t("newWorkspace.create")}
              submitIcon="return"
              isSubmitLoading={pendingAction !== null}
              submitBehavior="preserve-and-lock"
              blurOnSubmit={true}
              value={chatDraft.text}
              onChangeText={chatDraft.setText}
              attachments={chatDraft.attachments}
              onChangeAttachments={chatDraft.setAttachments}
              cwd={selectedSourceDirectory ?? ""}
              clearDraft={handleClearDraft}
              autoFocus
              commandDraftConfig={composerState?.commandDraftConfig}
              agentControls={agentControlsWithDisabled}
              onAddImages={handleAddImagesCallback}
              footer={composerFooter}
            />
            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
          </ReanimatedAnimated.View>
        </View>
      </View>
    </FileDropZone>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
    alignItems: "center",
  },
  contentCentered: {
    justifyContent: "center",
    paddingBottom: HEADER_INNER_HEIGHT + theme.spacing[6],
  },
  contentCompact: {
    justifyContent: "flex-end",
  },
  centered: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  composerTitleContainer: {
    marginBottom: theme.spacing[8],
    paddingLeft: theme.spacing[6],
    paddingRight: theme.spacing[4],
  },
  composerTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: 28,
    maxWidth: 240,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
  },
  checkoutHintBadge: {
    flexDirection: "row",
    alignItems: "center",
    height: 28,
    maxWidth: 240,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  checkoutHintAction: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  badgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  badgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  badgeDisabled: {
    opacity: 0.6,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  newBranchField: {
    minWidth: 180,
    maxWidth: 240,
  },
  newBranchInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    height: 28,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
  },
  newBranchInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    outlineWidth: 0,
  },
  newBranchErrorText: {
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  badgeIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  badgeProjectIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
  },
  badgeProjectIconFallback: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeProjectIconFallbackText: {
    fontSize: 10,
    fontWeight: "600",
  },
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  projectOptionIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
  },
  projectOptionIconFallback: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  projectOptionIconFallbackText: {
    fontSize: 10,
    fontWeight: "600",
  },
}));
