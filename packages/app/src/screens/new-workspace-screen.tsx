import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Pressable, Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNameId } from "mnemonic-id";
import { useQuery } from "@tanstack/react-query";
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
  pickerItemToCheckoutRequest,
  type PickerCheckoutRequest,
  type PickerItem,
} from "./new-workspace-picker-item";
import { findCheckoutHintPrAttachment, syncPickerPrAttachment } from "./new-workspace-picker-state";

function resolveCheckoutRequest(
  selectedItem: PickerItem | null,
  currentBranch: string | null,
): PickerCheckoutRequest | undefined {
  const selectedCheckoutRequest = pickerItemToCheckoutRequest(selectedItem);
  if (selectedCheckoutRequest) return selectedCheckoutRequest;
  if (!currentBranch) return undefined;
  return {
    action: "branch-off",
    refName: currentBranch,
  };
}

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
}

interface PickerOptionData {
  options: ComboboxOptionType[];
  itemById: Map<string, PickerItem>;
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
  // When true (workspaceMultiplicity), every project is selectable because a
  // local-backed workspace works for any directory, git or not. When false the
  // picker stays limited to worktree-capable projects (legacy behavior).
  allowAllProjects: boolean;
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

const BRANCH_OPTION_PREFIX = "branch:";
const PR_OPTION_PREFIX = "github-pr:";
const PROJECT_OPTION_PREFIX = "project:";
const PROJECT_ICON_FALLBACK_FONT_SIZE = 10;
// Height of a single picker-trigger badge. The Base-row spacer reserves exactly
// this so toggling Isolation to Local hides the row without shifting the form.
const BADGE_HEIGHT = 28;

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
                imageStyle={styles.projectIcon}
                fallbackStyle={styles.projectIconFallback}
                textStyle={styles.projectIconFallbackText}
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

function PickerOptionItem({
  testID,
  label,
  description,
  selected,
  active,
  disabled,
  onPress,
  isBranch,
  iconColor,
  iconSize,
}: {
  testID: string;
  label: string;
  description: string | undefined;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  isBranch: boolean;
  iconColor: string;
  iconSize: number;
}) {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        {isBranch ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <GitPullRequest size={iconSize} color={iconColor} />
        )}
      </View>
    ),
    [isBranch, iconSize, iconColor],
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

function BackingOptionItem({
  optionId,
  label,
  selected,
  active,
  disabled,
  onPress,
  iconColor,
  iconSize,
}: {
  optionId: string;
  label: string;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  iconColor: string;
  iconSize: number;
}) {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.rowIconBox}>
        {optionId === "worktree" ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <Folder size={iconSize} color={iconColor} />
        )}
      </View>
    ),
    [optionId, iconSize, iconColor],
  );
  return (
    <ComboboxItem
      testID={`workspace-create-backing-${optionId}`}
      label={label}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
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
          imageStyle={styles.projectIcon}
          fallbackStyle={styles.projectIconFallback}
          textStyle={styles.projectIconFallbackText}
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

function branchOptionId(name: string): string {
  return `${BRANCH_OPTION_PREFIX}${name}`;
}

function prOptionId(number: number): string {
  return `${PR_OPTION_PREFIX}${number}`;
}

function projectOptionId(projectId: string): string {
  return `${PROJECT_OPTION_PREFIX}${projectId}`;
}

function formatPrLabel(item: { number: number; title: string }): string {
  return `#${item.number} ${item.title}`;
}

function pickerItemLabel(item: PickerItem): string {
  return item.kind === "branch" ? item.name : formatPrLabel(item.item);
}

function pickerItemTriggerLabel(item: PickerItem): string {
  return pickerItemLabel(item);
}

function computePickerOptionData(
  branchDetails: ReadonlyArray<{ name: string; committerDate: number }>,
  prItems: ReadonlyArray<GitHubSearchItem>,
): PickerOptionData {
  const idMap = new Map<string, PickerItem>();

  interface TimedOption {
    option: ComboboxOptionType;
    timestamp: number;
  }
  const timedOptions: TimedOption[] = [];

  for (const branch of branchDetails) {
    const id = branchOptionId(branch.name);
    const option = { id, label: branch.name };
    idMap.set(id, { kind: "branch", name: branch.name });
    timedOptions.push({ option, timestamp: branch.committerDate });
  }

  for (const pr of prItems) {
    if (!pr.headRefName) continue;
    const id = prOptionId(pr.number);
    const option = { id, label: formatPrLabel(pr) };
    idMap.set(id, { kind: "github-pr", item: pr });
    const updatedAtMs = pr.updatedAt ? Date.parse(pr.updatedAt) : 0;
    const timestamp = Number.isNaN(updatedAtMs) ? 0 : Math.floor(updatedAtMs / 1000);
    timedOptions.push({ option, timestamp });
  }

  timedOptions.sort((a, b) => b.timestamp - a.timestamp);
  return { options: timedOptions.map((t) => t.option), itemById: idMap };
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
  allowAllProjects,
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
  const selectableProjects = useMemo(
    () => (allowAllProjects ? projects : projects.filter((project) => project.canCreateWorktree)),
    [allowAllProjects, projects],
  );

  // expo-router reuses the 'new' screen across navigations without remounting, so
  // a manual picker choice would otherwise stick when navigating to a different
  // project's New Workspace. Resetting on route project identity lets each
  // route-driven navigation preselect its own project; in-screen manual override
  // still works within a single visit.
  const routeProjectKey = routeProject?.projectKey ?? null;
  useEffect(() => {
    setManualProjectKey(null);
  }, [routeProjectKey]);

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
    () => computeProjectOptionData(selectableProjects),
    [selectableProjects],
  );
  const handleSelectProjectOption = useCallback(
    (id: string) => {
      const project = projectByOptionId.get(id);
      if (!project) return;
      if (!allowAllProjects && !project.canCreateWorktree) return;
      setManualProjectKey(project.projectKey);
    },
    [allowAllProjects, projectByOptionId],
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

function IsolationPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  backing,
  label,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  backing: "local" | "worktree";
  label: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <Pressable
      ref={pickerAnchorRef}
      testID="workspace-create-backing-trigger"
      onPress={onPress}
      disabled={disabled}
      style={badgePressableStyle}
      accessibilityRole="button"
      accessibilityLabel="Workspace isolation"
    >
      <View style={styles.badgeIconBox}>
        {backing === "worktree" ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <Folder size={iconSize} color={iconColor} />
        )}
      </View>
      <Text style={styles.badgeText} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={iconSize} color={iconColor} />
    </Pressable>
  );
}

// Each row aligns its label glyph with the screen heading glyph and lets the
// label's natural width push the control. The label and control sit side by
// side with no held horizontal space.
function LabeledRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

interface WorkspaceBackingState {
  backing: "local" | "worktree";
  setBacking: (value: "local" | "worktree") => void;
  effectiveBacking: "local" | "worktree";
  canCreateWorktree: boolean;
  showRefPicker: boolean;
}

// Worktree backing only makes sense for a git checkout. The effective backing
// falls back to local whenever the selected directory isn't git so the flow
// never submits an impossible request.
function useWorkspaceBacking(input: {
  supportsMultiplicity: boolean;
  selectedIsGit: boolean;
}): WorkspaceBackingState {
  const { supportsMultiplicity, selectedIsGit } = input;
  const [backing, setBacking] = useState<"local" | "worktree">("local");
  const canCreateWorktree = supportsMultiplicity && selectedIsGit;
  const isWorktree = backing === "worktree" && canCreateWorktree;

  useEffect(() => {
    if (backing === "worktree" && !canCreateWorktree) {
      setBacking("local");
    }
  }, [backing, canCreateWorktree]);

  return {
    backing,
    setBacking,
    effectiveBacking: isWorktree ? "worktree" : "local",
    canCreateWorktree,
    showRefPicker: !supportsMultiplicity || isWorktree,
  };
}

function backingLabel(t: TFunction, backing: "local" | "worktree"): string {
  return backing === "worktree"
    ? t("newWorkspace.backing.worktree")
    : t("newWorkspace.backing.local");
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
    | { branchDetails?: Array<{ name: string; committerDate: number }>; branches?: string[] }
    | undefined,
): Array<{ name: string; committerDate: number }> {
  const details = data?.branchDetails;
  if (details && details.length > 0) return details;
  const names = data?.branches ?? [];
  return names.map((name) => ({ name, committerDate: 0 }));
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
    ? { ...normalizedWorkspace, status: "running" as const, statusEnteredAt: new Date() }
    : normalizedWorkspace;
  input.mergeWorkspaces(input.serverId, [workspaceForInitialMerge]);
  return normalizedWorkspace;
}

async function createMultiplicityWorkspace(input: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  backing: "local" | "worktree";
  project: HostProjectListItem;
  selectedItem: PickerItem | null;
  currentBranch: string | null;
  withInitialAgent: boolean;
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const isWorktree = input.backing === "worktree";
  const baseBranch = isWorktree
    ? (resolveCheckoutRequest(input.selectedItem, input.currentBranch)?.refName ?? undefined)
    : undefined;
  const payload = await input.client.createWorkspace({
    backing: input.backing,
    cwd: input.project.iconWorkingDir,
    projectId: input.project.projectKey,
    ...(isWorktree ? { branch: createNameId() } : {}),
    ...(baseBranch ? { baseBranch } : {}),
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? input.createFailedMessage);
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceForInitialMerge = input.withInitialAgent
    ? { ...normalizedWorkspace, status: "running" as const, statusEnteredAt: new Date() }
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
    withInitialAgent: boolean;
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
    withInitialAgent: true,
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
  // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
  const supportsWorkspaceMultiplicity = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceMultiplicity === true,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | null>(null);
  const [manualPickerSelection, setManualPickerSelection] = useState<PickerSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [backingPickerOpen, setBackingPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const pickerAnchorRef = useRef<View>(null);
  const projectPickerAnchorRef = useRef<View>(null);
  const backingPickerAnchorRef = useRef<View>(null);

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
    allowAllProjects: supportsWorkspaceMultiplicity,
  });
  const projectIconDataByProjectKey = useProjectIconDataByProjectKey({ serverId, projects });
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
  const { effectiveBacking, setBacking, canCreateWorktree, showRefPicker } = useWorkspaceBacking({
    supportsMultiplicity: supportsWorkspaceMultiplicity,
    selectedIsGit: checkoutStatusQuery.data?.isGit === true,
  });

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
  const prItems: GitHubSearchItem[] = useMemo(() => {
    if (!githubFeaturesEnabled) return [];
    return githubPrSearchQuery.data?.items ?? [];
  }, [githubFeaturesEnabled, githubPrSearchQuery.data?.items]);

  const { options, itemById }: PickerOptionData = useMemo(
    () => computePickerOptionData(branchDetails, prItems),
    [branchDetails, prItems],
  );
  const triggerLabel = useMemo(() => {
    if (selectedItem) return pickerItemTriggerLabel(selectedItem);
    return currentBranch ?? "main";
  }, [currentBranch, selectedItem]);

  const selectedOptionId = useMemo(() => {
    if (!selectedItem) return "";
    return selectedItem.kind === "branch"
      ? branchOptionId(selectedItem.name)
      : prOptionId(selectedItem.item.number);
  }, [selectedItem]);
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
      // selectProjectOption enforces selectability (worktree-only when
      // multiplicity is off, any project when it's on); don't re-gate here on
      // canCreateWorktree or non-git projects become unselectable.
      selectProjectOption(id);
      setProjectPickerOpen(false);
      setManualPickerSelection(null);
    },
    [selectProjectOption],
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
    selectPickerItem({ kind: "github-pr", item: checkoutHintPrAttachment.item });
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

  const openBackingPicker = useCallback(() => {
    setBackingPickerOpen(true);
  }, []);

  const handleBackingPickerOpenChange = useCallback((nextOpen: boolean) => {
    setBackingPickerOpen(nextOpen);
  }, []);

  // "New worktree" is omitted entirely (not disabled) when the project isn't a
  // git checkout, since worktree backing is impossible there.
  const backingOptions = useMemo<ComboboxOptionType[]>(() => {
    const localOption = { id: "local", label: backingLabel(t, "local") };
    if (!canCreateWorktree) return [localOption];
    return [localOption, { id: "worktree", label: backingLabel(t, "worktree") }];
  }, [canCreateWorktree, t]);

  const handleSelectBackingOption = useCallback(
    (id: string) => {
      setBacking(id === "worktree" ? "worktree" : "local");
      setBackingPickerOpen(false);
    },
    [setBacking],
  );

  const renderBackingOption = useCallback(
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
      return (
        <BackingOptionItem
          optionId={option.id}
          label={option.label}
          selected={selected}
          active={active}
          disabled={isPending}
          onPress={onPress}
          iconColor={theme.colors.foregroundMuted}
          iconSize={theme.iconSize.sm}
        />
      );
    },
    [isPending, theme.colors.foregroundMuted, theme.iconSize.sm],
  );

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

  const buildCreateWorktreeInput = useCallback(
    (input: {
      cwd: string;
      prompt: string;
      attachments: AgentAttachment[];
    }): CreatePaseoWorktreeInput => {
      if (!selectedProject) {
        throw new Error("Choose a project");
      }
      const checkoutRequest = resolveCheckoutRequest(selectedItem, currentBranch);
      const trimmedPrompt = input.prompt.trim();
      const hasFirstAgentContext = trimmedPrompt.length > 0 || input.attachments.length > 0;

      return {
        cwd: selectedProject.iconWorkingDir,
        projectId: selectedProject.projectKey,
        worktreeSlug: createNameId(),
        ...(hasFirstAgentContext
          ? {
              firstAgentContext: {
                ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
                ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
              },
            }
          : {}),
        ...checkoutRequest,
      };
    },
    [currentBranch, selectedItem, selectedProject],
  );

  const ensureWorkspace = useCallback(
    async (input: {
      cwd: string;
      prompt: string;
      attachments: AgentAttachment[];
      withInitialAgent: boolean;
    }) => {
      if (createdWorkspace) {
        return createdWorkspace;
      }
      if (!selectedProject) {
        throw new Error("Choose a project");
      }
      const normalizedWorkspace = supportsWorkspaceMultiplicity
        ? await createMultiplicityWorkspace({
            client: withConnectedClient(),
            backing: effectiveBacking,
            project: selectedProject,
            selectedItem,
            currentBranch,
            withInitialAgent: input.withInitialAgent,
            mergeWorkspaces,
            serverId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          })
        : await createAndMergeWorkspace({
            client: withConnectedClient(),
            createInput: buildCreateWorktreeInput(input),
            mergeWorkspaces,
            serverId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      buildCreateWorktreeInput,
      createdWorkspace,
      currentBranch,
      effectiveBacking,
      mergeWorkspaces,
      selectedItem,
      selectedProject,
      serverId,
      supportsWorkspaceMultiplicity,
      t,
      withConnectedClient,
    ],
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

      const isBranch = item.kind === "branch";

      const testID = isBranch
        ? `new-workspace-ref-picker-branch-${item.name}`
        : `new-workspace-ref-picker-pr-${item.item.number}`;

      const description =
        !isBranch && item.item.baseRefName
          ? t("newWorkspace.refPicker.intoBase", { baseRef: item.item.baseRefName })
          : undefined;

      return (
        <PickerOptionItem
          testID={testID}
          label={pickerItemLabel(item)}
          description={description}
          selected={selected}
          active={active}
          disabled={isPending}
          onPress={onPress}
          isBranch={isBranch}
          iconColor={theme.colors.foregroundMuted}
          iconSize={theme.iconSize.sm}
        />
      );
    },
    [isPending, itemById, t, theme.colors.foregroundMuted, theme.iconSize.sm],
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
          disabled={isPending || (!supportsWorkspaceMultiplicity && !project.canCreateWorktree)}
          onPress={onPress}
        />
      );
    },
    [isPending, projectByOptionId, projectIconDataByProjectKey, supportsWorkspaceMultiplicity],
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

  const pickerEmptyText =
    branchSuggestionsQuery.isFetching || githubPrSearchQuery.isFetching
      ? t("newWorkspace.refPicker.searching")
      : t("newWorkspace.refPicker.noMatchingRefs");

  const backingTriggerLabel = backingLabel(t, effectiveBacking);

  const formStack = useMemo(
    () => (
      <View testID="new-workspace-ref-picker-row" style={styles.formStack}>
        <LabeledRow label={t("newWorkspace.fields.project")}>
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
        </LabeledRow>
        {/* The Isolation row keeps its height for non-git projects so switching
            projects never shifts the form; worktree backing is git-only, so a
            non-git project renders an invisible spacer matching the trigger
            height exactly. */}
        {canCreateWorktree ? (
          <LabeledRow label={t("newWorkspace.backing.label")}>
            <View>
              <IsolationPickerTrigger
                pickerAnchorRef={backingPickerAnchorRef}
                onPress={openBackingPicker}
                disabled={isPending}
                badgePressableStyle={badgePressableStyle}
                backing={effectiveBacking}
                label={backingTriggerLabel}
                iconColor={theme.colors.foregroundMuted}
                iconSize={theme.iconSize.sm}
              />
              <Combobox
                options={backingOptions}
                value={effectiveBacking}
                onSelect={handleSelectBackingOption}
                title={t("newWorkspace.backing.label")}
                open={backingPickerOpen}
                onOpenChange={handleBackingPickerOpenChange}
                desktopPlacement="bottom-start"
                anchorRef={backingPickerAnchorRef}
                renderOption={renderBackingOption}
              />
            </View>
          </LabeledRow>
        ) : (
          <View style={styles.baseSpacer} />
        )}
        {/* The Base row keeps its height so toggling Isolation never shifts the
            form; on Local backing it renders an invisible spacer with no label
            or control, matching the trigger height exactly. */}
        {showRefPicker ? (
          <LabeledRow label={t("newWorkspace.fields.base")}>
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
          </LabeledRow>
        ) : (
          <View style={styles.baseSpacer} />
        )}
      </View>
    ),
    [
      backingOptions,
      backingPickerOpen,
      backingTriggerLabel,
      badgePressableStyle,
      canCreateWorktree,
      effectiveBacking,
      handleBackingPickerOpenChange,
      handlePickerOpenChange,
      handleProjectPickerOpenChange,
      handleSelectBackingOption,
      handleSelectOption,
      handleSelectProjectOption,
      isPending,
      openBackingPicker,
      openPicker,
      openProjectPicker,
      options,
      pickerEmptyText,
      pickerOpen,
      projectPickerOpen,
      projectPickerOptions,
      projectTriggerLabel,
      projectIconDataByProjectKey,
      renderBackingOption,
      renderPickerOption,
      renderProjectOption,
      selectedItem,
      selectedOptionId,
      selectedProject,
      selectedProjectOptionId,
      selectedSourceDirectory,
      setPickerSearchQuery,
      showRefPicker,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
      triggerLabel,
    ],
  );

  const composerFooter = useMemo(
    () => (
      <>
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
      </>
    ),
    [
      acceptCheckoutHint,
      agentControlsWithDisabled,
      checkoutHintPrAttachment,
      dismissCheckoutHint,
      t,
      theme.colors.foregroundMuted,
      theme.iconSize.sm,
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
            {formStack}
            <Composer
              agentId={draftKey}
              serverId={serverId}
              isPaneFocused={true}
              onSubmitMessage={handleSubmitNewWorkspace}
              allowEmptySubmit={true}
              submitButtonAccessibilityLabel={t("newWorkspace.create")}
              submitButtonTestID="workspace-create-submit"
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
  formStack: {
    marginBottom: theme.spacing[8],
    gap: theme.spacing[2],
  },
  // The row's left inset matches the heading's text x (composerTitleContainer
  // paddingLeft) so each label glyph aligns with the "New workspace" glyph. The
  // label keeps its natural width and the control sits immediately beside it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[6],
    gap: theme.spacing[1],
  },
  rowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  baseSpacer: {
    height: BADGE_HEIGHT,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: BADGE_HEIGHT,
    maxWidth: 240,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    gap: theme.spacing[1],
  },
  checkoutHintBadge: {
    flexDirection: "row",
    alignItems: "center",
    height: BADGE_HEIGHT,
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
  projectIcon: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: {
    // Single uppercase initial inside an iconSize.md (16px) square — below the
    // smallest font-size token, so it stays a literal sized to the box.
    fontSize: PROJECT_ICON_FALLBACK_FONT_SIZE,
    fontWeight: "600",
  },
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
