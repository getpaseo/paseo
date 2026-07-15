import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Pressable, Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNameId } from "mnemonic-id";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  X,
} from "lucide-react-native";
import { Composer } from "@/composer";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { DraftAgentModeControl } from "@/composer/agent-controls/mode-control";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { HostStatusDot } from "@/components/host-status-dot";
import { HostPicker } from "@/components/hosts/host-picker";
import { ProjectIconView } from "@/components/project-icon-view";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import type { ComboboxOption as ComboboxOptionType, ComboboxProps } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { HEADER_INNER_HEIGHT, MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useGithubSearchQuery } from "@/git/use-github-search-query";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import type { HostProfile } from "@/types/host-connection";
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import {
  useWorkspaceDraftSubmissionStore,
  type PendingWorkspaceDraftSetup,
} from "@/stores/workspace-draft-submission-store";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import {
  getHostProjectSourceDirectory,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  useHostProjects,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { useDraftWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import type { MessagePayload } from "@/composer/types";
import type { AgentAttachment, GitHubSearchItem } from "@getpaseo/protocol/messages";
import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } from "./new-workspace-empty";
import {
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
} from "./new-workspace-fork-context";
import {
  pickerItemToCheckoutRequest,
  type PickerCheckoutRequest,
  type PickerItem,
} from "./new-workspace-picker-item";
import {
  clearPickerPrAttachmentForTargetChange,
  findCheckoutHintPrAttachment,
  syncPickerPrAttachment,
} from "./new-workspace-picker-state";
import {
  resolveNewWorkspaceAutomaticServerId,
  resolveNewWorkspaceInitialServerId,
} from "./new-workspace-initial-context";
import { useNewWorkspaceProjectPicker } from "./new-workspace/project-picker";

const ThemedFolderPlus = withUnistyles(FolderPlus);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const addProjectIcon = (
  <ThemedFolderPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

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

function useIsNewWorkspaceDraftHandoffActive(input: {
  draftId: string | undefined;
  selectedServerId: string;
}): boolean {
  const normalizedDraftId = input.draftId?.trim() ?? "";
  return useCreateFlowStore((state) =>
    isActiveCreateFlowForDraft({
      draftId: normalizedDraftId,
      serverId: input.selectedServerId,
      pending: normalizedDraftId ? state.pendingByDraftId[normalizedDraftId] : null,
    }),
  );
}

function resolveVisibleDraftContextScopeKeys(input: {
  isDraftHandoffActive: boolean;
  draftContextScopeKey: string;
}): readonly string[] {
  if (input.isDraftHandoffActive || !input.draftContextScopeKey) {
    return [];
  }
  return [input.draftContextScopeKey];
}

function isNewWorkspacePending(input: {
  pendingAction: "chat" | "empty" | null;
  isDraftHandoffActive: boolean;
}): boolean {
  return input.pendingAction !== null || input.isDraftHandoffActive;
}

function buildFirstAgentContext(input: {
  prompt: string;
  attachments: AgentAttachment[];
}): { prompt?: string; attachments?: AgentAttachment[] } | undefined {
  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt && input.attachments.length === 0) {
    return undefined;
  }

  return {
    ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
    attachments: input.attachments,
  };
}

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
}

interface PickerOptionData {
  options: ComboboxOptionType[];
  itemById: Map<string, PickerItem>;
}

interface PickerSelection {
  item: PickerItem;
}

const BRANCH_OPTION_PREFIX = "branch:";
const PR_OPTION_PREFIX = "github-pr:";
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
        <ComboboxTrigger
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
        </ComboboxTrigger>
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
        <ComboboxTrigger
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
        </ComboboxTrigger>
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

function IsolationOptionItem({
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
      testID={`workspace-create-isolation-${optionId}`}
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

function NewWorkspacePickerOption({
  option,
  selected,
  active,
  onPress,
  itemById,
  isPending,
}: {
  option: ComboboxOptionType;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  itemById: Map<string, PickerItem>;
  isPending: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
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
}

function NewWorkspaceProjectPickerOption({
  option,
  selected,
  active,
  onPress,
  projectByOptionId,
  projectIconDataByProjectKey,
  selectedServerId,
  isPending,
  supportsWorkspaceMultiplicity,
}: {
  option: ComboboxOptionType;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  projectByOptionId: Map<string, HostProjectListItem>;
  projectIconDataByProjectKey: Map<string, string | null>;
  selectedServerId: string;
  isPending: boolean;
  supportsWorkspaceMultiplicity: boolean;
}) {
  const project = projectByOptionId.get(option.id);
  if (!project) return <View key={option.id} />;
  const sourceDirectory =
    getHostProjectSourceDirectory(project, selectedServerId) ?? project.iconWorkingDir;

  return (
    <ProjectOptionItem
      testID={`new-workspace-project-picker-option-${project.projectKey}`}
      projectKey={project.projectKey}
      iconDataUri={projectIconDataByProjectKey.get(project.projectKey) ?? null}
      label={project.projectName}
      description={sourceDirectory}
      selected={selected}
      active={active}
      disabled={
        isPending ||
        (!supportsWorkspaceMultiplicity && !project.hosts.some((host) => host.canCreateWorktree))
      }
      onPress={onPress}
    />
  );
}

function AddProjectPickerAction({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const openProjectKeys = useShortcutKeys("new-agent");
  const shortcut = useMemo(
    () => (openProjectKeys ? <Shortcut chord={openProjectKeys} /> : null),
    [openProjectKeys],
  );

  return (
    <ComboboxItem
      testID="new-workspace-project-picker-add-project"
      label={t("sidebar.actions.addProject")}
      onPress={onPress}
      leadingSlot={addProjectIcon}
      trailingSlot={shortcut}
    />
  );
}

function formatPrLabel(item: { number: number; title: string }): string {
  return `#${item.number} ${item.title}`;
}

function pickerItemLabel(item: PickerItem): string {
  return item.kind === "branch" ? item.name : formatPrLabel(item.item);
}

function pickerItemTriggerLabel(item: PickerItem): string {
  return item.kind === "branch" ? item.name : formatPrLabel(item.item);
}

function newWorkspaceHostOptionTestID(serverId: string): string {
  return `new-workspace-host-picker-option-${serverId}`;
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

function IsolationPickerTrigger({
  pickerAnchorRef,
  onPress,
  disabled,
  badgePressableStyle,
  isolation,
  label,
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  isolation: "local" | "worktree";
  label: string;
  iconColor: string;
  iconSize: number;
}) {
  return (
    <ComboboxTrigger
      ref={pickerAnchorRef}
      testID="workspace-create-isolation-trigger"
      onPress={onPress}
      disabled={disabled}
      style={badgePressableStyle}
      accessibilityRole="button"
      accessibilityLabel="Workspace isolation"
    >
      <View style={styles.badgeIconBox}>
        {isolation === "worktree" ? (
          <GitBranch size={iconSize} color={iconColor} />
        ) : (
          <Folder size={iconSize} color={iconColor} />
        )}
      </View>
      <Text style={styles.badgeText} numberOfLines={1}>
        {label}
      </Text>
    </ComboboxTrigger>
  );
}

// Wraps a single argument control in the mobile vertical stack. On desktop the
// controls are laid out in one horizontal row, so no per-control wrapper is used.
function FormRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

interface WorkspaceIsolationState {
  isolation: "local" | "worktree";
  setIsolation: (value: "local" | "worktree") => void;
  effectiveIsolation: "local" | "worktree";
  canCreateWorktree: boolean;
  showRefPicker: boolean;
}

// Worktree isolation only makes sense for a git checkout. The effective isolation
// falls back to local whenever the selected directory isn't git so the flow
// never submits an impossible request.
function useWorkspaceIsolation(input: {
  supportsMultiplicity: boolean;
  selectedIsGit: boolean;
}): WorkspaceIsolationState {
  const { supportsMultiplicity, selectedIsGit } = input;
  // The last isolation choice is remembered alongside the other New Workspace
  // form preferences (provider, model, mode). A manual in-screen pick overrides
  // the remembered default until the screen remounts.
  const { preferences, updatePreferences } = useFormPreferences();
  const [manualIsolation, setManualIsolation] = useState<"local" | "worktree" | null>(null);
  const isolation = manualIsolation ?? preferences.isolation ?? "local";
  const canCreateWorktree = supportsMultiplicity && selectedIsGit;
  const isWorktree = isolation === "worktree" && canCreateWorktree;

  const setIsolation = useCallback(
    (value: "local" | "worktree") => {
      setManualIsolation(value);
      void updatePreferences({ isolation: value });
    },
    [updatePreferences],
  );

  return {
    isolation,
    setIsolation,
    effectiveIsolation: isWorktree ? "worktree" : "local",
    canCreateWorktree,
    showRefPicker: !supportsMultiplicity || isWorktree,
  };
}

function isolationLabel(t: TFunction, isolation: "local" | "worktree"): string {
  return isolation === "worktree"
    ? t("newWorkspace.isolation.worktree")
    : t("newWorkspace.isolation.local");
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
  draftId?: string;
  initialSetup?: WorkspaceDraftTabSetup;
  workspaceId: string;
  workspaceDirectory: string;
  text: string;
  attachments: ComposerAttachment[];
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
}

type NewWorkspaceComposerState = NonNullable<
  ReturnType<typeof useAgentInputDraft>["composerState"]
>;

interface WorkspaceDraftSubmissionConfig {
  cwd: string;
  provider: AgentProvider;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
  target: WorkspaceTabTarget;
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
  isolation: "local" | "worktree";
  project: HostProjectListItem;
  sourceDirectory: string;
  selectedItem: PickerItem | null;
  currentBranch: string | null;
  withInitialAgent: boolean;
  prompt: string;
  attachments: AgentAttachment[];
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const isWorktree = input.isolation === "worktree";
  const checkoutRequest = isWorktree
    ? resolveCheckoutRequest(input.selectedItem, input.currentBranch)
    : undefined;
  const firstAgentContext = buildFirstAgentContext({
    prompt: input.prompt,
    attachments: input.attachments,
  });
  const payload = await input.client.createWorkspace({
    source: isWorktree
      ? {
          kind: "worktree",
          cwd: input.sourceDirectory,
          projectId: input.project.projectKey,
          worktreeSlug: createNameId(),
          ...checkoutRequest,
        }
      : {
          kind: "directory",
          path: input.sourceDirectory,
          projectId: input.project.projectKey,
        },
    ...(firstAgentContext ? { firstAgentContext } : {}),
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
  forkDraftSetup?: PendingWorkspaceDraftSetup | null;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  serverId: string;
  draftKey: string;
  draftId?: string;
  labels: {
    composerStateRequired: string;
    selectModel: string;
  };
}

function buildWorkspaceDraftSetupFromComposer(input: {
  cwd: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
}): WorkspaceDraftTabSetup {
  return {
    provider: input.provider,
    cwd: input.cwd,
    modeId: input.composerState.selectedMode || null,
    model: input.composerState.effectiveModelId || null,
    thinkingOptionId: input.composerState.effectiveThinkingOptionId || null,
    featureValues: input.composerState.featureValues ?? {},
  };
}

function buildWorkspaceDraftSetupForCreatedWorkspace(input: {
  forkDraftSetup: PendingWorkspaceDraftSetup | null | undefined;
  workspaceDirectory: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
}): WorkspaceDraftTabSetup | undefined {
  if (!input.forkDraftSetup) {
    return undefined;
  }
  return buildWorkspaceDraftSetupFromComposer({
    cwd: remapDraftCwdToWorkspace({
      cwd: input.forkDraftSetup.setup.cwd,
      sourceDirectory: input.forkDraftSetup.sourceDirectory,
      workspaceDirectory: input.workspaceDirectory,
    }),
    provider: input.provider,
    composerState: input.composerState,
  });
}

function buildComposerInitialValues(input: {
  workingDir: string | undefined;
  initialSetup?: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (input.initialSetup) {
    return {
      workingDir: input.workingDir ?? input.initialSetup.cwd,
      provider: input.initialSetup.provider,
      modeId: input.initialSetup.modeId,
      model: input.initialSetup.model,
      thinkingOptionId: input.initialSetup.thinkingOptionId,
    };
  }
  if (input.workingDir) {
    return { workingDir: input.workingDir };
  }
  return undefined;
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
  const workspaceNamingAttachments = getWorkspaceNamingAttachments(reviewAttachments);
  const ensuredWorkspace = await ensureWorkspace({
    cwd,
    prompt: text,
    attachments: workspaceNamingAttachments,
    withInitialAgent: true,
  });
  const initialSetup = buildWorkspaceDraftSetupForCreatedWorkspace({
    forkDraftSetup: input.forkDraftSetup,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    provider,
    composerState,
  });
  submitWorkspaceDraft({
    serverId,
    draftKey,
    draftId: input.draftId,
    initialSetup,
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
  initialSetup?: WorkspaceDraftTabSetup | null;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, isConnected, workspaceDirectory, sourceDirectory, initialSetup } = input;
  const workingDir = workspaceDirectory || sourceDirectory || undefined;
  return {
    initialServerId: serverId || null,
    initialValues: buildComposerInitialValues({ workingDir, initialSetup }),
    initialFeatureValues: initialSetup?.featureValues,
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

function usePendingWorkspaceDraftSetup(
  draftId: string | undefined,
): PendingWorkspaceDraftSetup | null {
  const normalizedDraftId = draftId?.trim() ?? "";
  return useWorkspaceDraftSubmissionStore((state) => {
    if (!normalizedDraftId) {
      return null;
    }
    return state.setupByDraftId[normalizedDraftId] ?? null;
  });
}

function resolveWorkspaceDraftSubmissionConfig(input: {
  draftId: string;
  workspaceDirectory: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
  initialSetup?: WorkspaceDraftTabSetup;
}): WorkspaceDraftSubmissionConfig {
  const { draftId, workspaceDirectory, provider, composerState, initialSetup } = input;
  if (initialSetup) {
    return {
      cwd: initialSetup.cwd,
      provider: initialSetup.provider,
      modeId: initialSetup.modeId,
      model: initialSetup.model,
      thinkingOptionId: initialSetup.thinkingOptionId,
      featureValues: initialSetup.featureValues,
      target: { kind: "draft", draftId, setup: initialSetup },
    };
  }
  return {
    cwd: workspaceDirectory,
    provider,
    modeId: composerState.selectedMode || null,
    model: composerState.effectiveModelId || null,
    thinkingOptionId: composerState.effectiveThinkingOptionId || null,
    featureValues: composerState.featureValues,
    target: { kind: "draft", draftId },
  };
}

function submitWorkspaceDraft(input: SubmitDraftInput): void {
  const {
    serverId,
    draftKey,
    draftId: draftIdInput,
    workspaceId,
    workspaceDirectory,
    text,
    attachments,
    provider,
    composerState,
    initialSetup,
  } = input;
  const draftId = draftIdInput?.trim() || generateDraftId();
  const clientMessageId = generateMessageId();
  const timestamp = Date.now();
  const wirePayload = splitComposerAttachmentsForSubmit(attachments);
  const submission = resolveWorkspaceDraftSubmissionConfig({
    draftId,
    workspaceDirectory,
    provider,
    composerState,
    initialSetup,
  });
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
    cwd: submission.cwd,
    provider: submission.provider,
    clientMessageId,
    timestamp,
    ...(submission.modeId ? { modeId: submission.modeId } : {}),
    ...(submission.model ? { model: submission.model } : {}),
    ...(submission.thinkingOptionId ? { thinkingOptionId: submission.thinkingOptionId } : {}),
    ...(submission.featureValues ? { featureValues: submission.featureValues } : {}),
    allowEmptyText: true,
  });
  navigateToWorkspace({
    serverId,
    workspaceId,
    target: submission.target,
  });
  useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "sent" });
}

function useNewWorkspaceHostSelector(input: {
  initialServerId: string;
  allServerIds: string[];
  projects: HostProjectListItem[];
  lastActiveProject: HostProjectListItem | null;
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  const routeServerId = input.initialServerId.trim();
  const defaultServerId = useMemo(
    () =>
      resolveNewWorkspaceInitialServerId({
        allServerIds: input.allServerIds,
        routeServerId: input.initialServerId,
        lastActiveProject: input.lastActiveProject,
        projects: input.projects,
        hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
        workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
      }),
    [
      input.allServerIds,
      input.hostConnectionStatusByServerId,
      input.initialServerId,
      input.lastActiveProject,
      input.projects,
      input.workspaceMultiplicityByServerId,
    ],
  );
  const [automaticSelection, setAutomaticSelection] = useState(() => ({
    routeServerId,
    serverId: defaultServerId,
  }));
  const [manualSelection, setManualSelection] = useState<{
    routeServerId: string;
    serverId: string;
  } | null>(null);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);

  useEffect(() => {
    setAutomaticSelection((current) => {
      const nextServerId =
        current.routeServerId === routeServerId
          ? resolveNewWorkspaceAutomaticServerId({
              allServerIds: input.allServerIds,
              routeServerId: input.initialServerId,
              lastActiveProject: input.lastActiveProject,
              projects: input.projects,
              hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
              workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
              currentServerId: current.serverId,
              nextServerId: defaultServerId,
            })
          : defaultServerId;

      if (current.routeServerId === routeServerId && current.serverId === nextServerId) {
        return current;
      }

      return { routeServerId, serverId: nextServerId };
    });
  }, [
    defaultServerId,
    input.allServerIds,
    input.hostConnectionStatusByServerId,
    input.initialServerId,
    input.lastActiveProject,
    input.projects,
    input.workspaceMultiplicityByServerId,
    routeServerId,
  ]);

  const automaticServerId =
    automaticSelection.routeServerId === routeServerId &&
    input.allServerIds.includes(automaticSelection.serverId)
      ? automaticSelection.serverId
      : defaultServerId;
  const selectedServerId =
    manualSelection?.routeServerId === routeServerId &&
    input.allServerIds.includes(manualSelection.serverId)
      ? manualSelection.serverId
      : automaticServerId;

  const handleSelectHost = useCallback(
    (id: string) => {
      setManualSelection({ routeServerId, serverId: id });
      setHostPickerOpen(false);
    },
    [routeServerId],
  );

  const handleHostPickerOpenChange = useCallback((open: boolean) => {
    setHostPickerOpen(open);
  }, []);

  const openHostPicker = useCallback(() => {
    setHostPickerOpen(true);
  }, []);

  return {
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
  };
}

interface NewWorkspaceInitialContextState {
  allHosts: HostProfile[];
  selectedServerId: string;
  hostPickerOpen: boolean;
  handleSelectHost: (id: string) => void;
  handleHostPickerOpenChange: (open: boolean) => void;
  openHostPicker: () => void;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}

function useNewWorkspaceInitialContext({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
}: NewWorkspaceScreenProps): NewWorkspaceInitialContextState {
  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);
  const routeDisplayName = displayNameProp?.trim() ?? "";
  const routeProject = useMemo(
    () =>
      hostProjectFromRoute({
        serverId,
        projectId,
        displayName: routeDisplayName,
        sourceDirectory: sourceDirectoryProp,
      }),
    [projectId, routeDisplayName, serverId, sourceDirectoryProp],
  );
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const lastWorkspaceServerId = useMemo(
    () =>
      lastWorkspaceSelection && allServerIds.includes(lastWorkspaceSelection.serverId)
        ? lastWorkspaceSelection.serverId
        : null,
    [allServerIds, lastWorkspaceSelection],
  );
  const lastWorkspaceId = lastWorkspaceServerId ? lastWorkspaceSelection!.workspaceId : null;
  const lastWorkspace = useWorkspace(lastWorkspaceServerId, lastWorkspaceId);
  const lastActiveProject = useMemo(
    () =>
      lastWorkspaceServerId
        ? hostProjectFromWorkspace({ serverId: lastWorkspaceServerId, workspace: lastWorkspace })
        : null,
    [lastWorkspace, lastWorkspaceServerId],
  );
  const hostConnectionStatusByServerId = useHostRuntimeConnectionStatuses(allServerIds);
  const workspaceMultiplicityByServerId = useHostFeatureMap(allServerIds, "workspaceMultiplicity");
  const {
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
  } = useNewWorkspaceHostSelector({
    initialServerId: serverId,
    allServerIds,
    projects,
    lastActiveProject,
    hostConnectionStatusByServerId,
    workspaceMultiplicityByServerId,
  });

  return {
    allHosts,
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
    projects,
    routeProject,
    lastActiveProject,
  };
}

type RefPickerRenderOption = NonNullable<ComboboxProps["renderOption"]>;

interface FormPickerControl {
  anchorRef: RefObject<View | null>;
  open: () => void;
  openState: boolean;
  onOpenChange: (open: boolean) => void;
}

interface NewWorkspaceFormStackInput {
  isCompact: boolean;
  isPending: boolean;
  project: FormPickerControl & {
    options: ComboboxOptionType[];
    triggerLabel: string;
    selectedProject: HostProjectListItem | null;
    iconDataByProjectKey: Map<string, string | null>;
    selectedOptionId: string;
    onSelect: (id: string) => void;
    onAddProject: () => void;
    renderOption: RefPickerRenderOption;
  };
  host: FormPickerControl & {
    allHosts: HostProfile[];
    selectedServerId: string;
    onSelect: (id: string) => void;
  };
  isolation: FormPickerControl & {
    effectiveIsolation: "local" | "worktree";
    options: ComboboxOptionType[];
    onSelect: (id: string) => void;
    renderOption: RefPickerRenderOption;
    canCreateWorktree: boolean;
  };
  base: FormPickerControl & {
    selectedSourceDirectory: string | null;
    selectedItem: PickerItem | null;
    triggerLabel: string;
    options: ComboboxOptionType[];
    selectedOptionId: string;
    onSelect: (id: string) => void;
    setSearchQuery: (query: string) => void;
    emptyText: string;
    renderOption: RefPickerRenderOption;
    showRefPicker: boolean;
  };
}

function useNewWorkspaceFormStack(input: NewWorkspaceFormStackInput): ReactElement {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { isCompact, isPending, project, host, isolation, base } = input;

  const selectedHostLabel =
    host.allHosts.find((h) => h.serverId === host.selectedServerId)?.label ?? "Host";
  const showHostControl = host.allHosts.length > 1;
  const isolationTriggerLabel = isolationLabel(t, isolation.effectiveIsolation);
  const addProjectAction = useMemo(
    () => <AddProjectPickerAction onPress={project.onAddProject} />,
    [project.onAddProject],
  );

  const badgePressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.badge,
      Boolean(hovered) && !isPending && styles.badgeHovered,
      pressed && !isPending && styles.badgePressed,
      isPending && styles.badgeDisabled,
    ],
    [isPending],
  );

  const projectControl = (
    <View>
      <ProjectPickerTrigger
        pickerAnchorRef={project.anchorRef}
        onPress={project.open}
        disabled={isPending}
        badgePressableStyle={badgePressableStyle}
        label={project.triggerLabel}
        projectKey={project.selectedProject?.projectKey ?? null}
        iconDataUri={
          project.selectedProject
            ? (project.iconDataByProjectKey.get(project.selectedProject.projectKey) ?? null)
            : null
        }
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={project.options}
        value={project.selectedOptionId}
        onSelect={project.onSelect}
        searchable
        searchPlaceholder="Search projects"
        title="Project"
        open={project.openState}
        onOpenChange={project.onOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={project.anchorRef}
        emptyText="No projects available."
        renderOption={project.renderOption}
        footer={addProjectAction}
      />
    </View>
  );

  const hostControl = showHostControl ? (
    <View>
      <HostPicker
        hosts={host.allHosts}
        value={host.selectedServerId}
        onSelect={host.onSelect}
        open={host.openState}
        onOpenChange={host.onOpenChange}
        anchorRef={host.anchorRef}
        searchable={false}
        title="Host"
        desktopPlacement="bottom-start"
        hostOptionTestID={newWorkspaceHostOptionTestID}
      >
        <Pressable
          ref={host.anchorRef}
          onPress={host.open}
          disabled={isPending || host.allHosts.length === 0}
          style={badgePressableStyle}
          testID="host-picker-trigger"
        >
          <HostStatusDot serverId={host.selectedServerId} />
          <Text style={styles.badgeText} numberOfLines={1}>
            {selectedHostLabel}
          </Text>
          <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        </Pressable>
      </HostPicker>
    </View>
  ) : null;

  const isolationControl = isolation.canCreateWorktree ? (
    <View>
      <IsolationPickerTrigger
        pickerAnchorRef={isolation.anchorRef}
        onPress={isolation.open}
        disabled={isPending}
        badgePressableStyle={badgePressableStyle}
        isolation={isolation.effectiveIsolation}
        label={isolationTriggerLabel}
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={isolation.options}
        value={isolation.effectiveIsolation}
        onSelect={isolation.onSelect}
        title={t("newWorkspace.isolation.label")}
        open={isolation.openState}
        onOpenChange={isolation.onOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={isolation.anchorRef}
        renderOption={isolation.renderOption}
      />
    </View>
  ) : null;

  const baseControl = base.showRefPicker ? (
    <View>
      <RefPickerTrigger
        pickerAnchorRef={base.anchorRef}
        onPress={base.open}
        disabled={isPending || !base.selectedSourceDirectory}
        badgePressableStyle={badgePressableStyle}
        selectedItem={base.selectedItem}
        triggerLabel={base.triggerLabel}
        accessibilityLabel={t("newWorkspace.refPicker.startingRef")}
        tooltipLabel={t("newWorkspace.refPicker.chooseStart")}
        iconColor={theme.colors.foregroundMuted}
        iconSize={theme.iconSize.sm}
      />
      <Combobox
        options={base.options}
        value={base.selectedOptionId}
        onSelect={base.onSelect}
        searchable
        searchPlaceholder={t("newWorkspace.refPicker.searchPlaceholder")}
        title={t("newWorkspace.refPicker.title")}
        open={base.openState}
        onOpenChange={base.onOpenChange}
        onSearchQueryChange={base.setSearchQuery}
        desktopPlacement="bottom-start"
        anchorRef={base.anchorRef}
        emptyText={base.emptyText}
        renderOption={base.renderOption}
      />
    </View>
  ) : null;

  return isCompact ? (
    <View testID="new-workspace-ref-picker-row" style={styles.formStack}>
      <FormRow>{projectControl}</FormRow>
      {hostControl ? <FormRow>{hostControl}</FormRow> : null}
      {/* Keep fixed row height when git-only controls are hidden. */}
      {isolationControl ? (
        <FormRow>{isolationControl}</FormRow>
      ) : (
        <View style={styles.baseSpacer} />
      )}
      {baseControl ? <FormRow>{baseControl}</FormRow> : <View style={styles.baseSpacer} />}
    </View>
  ) : (
    <View testID="new-workspace-ref-picker-row" style={styles.formStackDesktop}>
      {projectControl}
      {hostControl}
      {isolationControl}
      {baseControl}
    </View>
  );
}

export function NewWorkspaceScreen({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
  draftId,
}: NewWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const {
    allHosts,
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
    projects,
    routeProject,
    lastActiveProject,
  } = useNewWorkspaceInitialContext({
    serverId,
    sourceDirectory: sourceDirectoryProp,
    projectId,
    displayName: displayNameProp,
  });
  // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
  const supportsWorkspaceMultiplicity = useHostFeature(selectedServerId, "workspaceMultiplicity");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | null>(null);
  const [manualPickerSelection, setManualPickerSelection] = useState<PickerSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const openAddProjectPicker = useOpenAddProject();
  const [isolationPickerOpen, setIsolationPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const pickerAnchorRef = useRef<View>(null);
  const projectPickerAnchorRef = useRef<View>(null);
  const isolationPickerAnchorRef = useRef<View>(null);
  const hostPickerAnchorRef = useRef<View | null>(null);
  const isDraftHandoffActive = useIsNewWorkspaceDraftHandoffActive({ draftId, selectedServerId });

  useEffect(() => {
    const trimmed = pickerSearchQuery.trim();
    const timer = setTimeout(() => setDebouncedPickerSearchQuery(trimmed), 180);
    return () => clearTimeout(timer);
  }, [pickerSearchQuery]);

  const workspace = createdWorkspace;
  const isPending = isNewWorkspacePending({ pendingAction, isDraftHandoffActive });
  const client = useHostRuntimeClient(selectedServerId);
  const isConnected = useHostRuntimeIsConnected(selectedServerId);
  const {
    selectedProject,
    selectedSourceDirectory,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId,
    projectTriggerLabel,
    handleSelectProjectOption: selectProjectOption,
  } = useNewWorkspaceProjectPicker({
    selectedServerId,
    projects,
    routeProject,
    lastActiveProject,
    allowAllProjects: supportsWorkspaceMultiplicity,
  });
  const projectIconTargets = useMemo(
    () =>
      projects.flatMap((project) => {
        const iconWorkingDir = getHostProjectSourceDirectory(project, selectedServerId)?.trim();
        if (!iconWorkingDir) {
          return [];
        }
        return [{ projectKey: project.projectKey, serverId: selectedServerId, iconWorkingDir }];
      }),
    [projects, selectedServerId],
  );

  const projectIconDataByProjectKey = useProjectIconDataByProjectKey({
    projects: projectIconTargets,
  });
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const forkDraftSetup = usePendingWorkspaceDraftSetup(draftId);
  const draftContextScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const visibleDraftContextScopeKeys = useMemo(
    () => resolveVisibleDraftContextScopeKeys({ isDraftHandoffActive, draftContextScopeKey }),
    [draftContextScopeKey, isDraftHandoffActive],
  );
  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: buildComposerConfig({
      serverId: selectedServerId,
      isConnected,
      workspaceDirectory: workspace?.workspaceDirectory ?? null,
      sourceDirectory: selectedSourceDirectory,
      initialSetup: forkDraftSetup?.setup,
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
    queryKey: ["checkout-status", selectedServerId, selectedSourceDirectory],
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
  const { effectiveIsolation, setIsolation, canCreateWorktree, showRefPicker } =
    useWorkspaceIsolation({
      supportsMultiplicity: supportsWorkspaceMultiplicity,
      selectedIsGit: checkoutStatusQuery.data?.isGit === true,
    });

  const branchSuggestionsQuery = useQuery({
    queryKey: [
      "branch-suggestions",
      selectedServerId,
      selectedSourceDirectory,
      debouncedPickerSearchQuery,
    ],
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
    serverId: selectedServerId,
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
      const nextAttachments = syncPickerPrAttachment({
        attachments: chatDraft.attachments,
        item,
      });

      setManualPickerSelection({ item });
      chatDraft.setAttachments(nextAttachments);
      setPickerOpen(false);
    },
    [chatDraft],
  );

  const handleSelectOption = useCallback(
    (id: string) => {
      const item = itemById.get(id);
      if (!item) return;
      selectPickerItem(item);
    },
    [itemById, selectPickerItem],
  );

  const clearManualPickerSelectionForTargetChange = useCallback(
    (currentTargetId: string, nextTargetId: string) => {
      const nextAttachments = clearPickerPrAttachmentForTargetChange({
        attachments: chatDraft.attachments,
        currentTargetId,
        nextTargetId,
      });
      if (nextAttachments === chatDraft.attachments) return;
      chatDraft.setAttachments(nextAttachments);
      setManualPickerSelection(null);
    },
    [chatDraft],
  );

  const handleSelectProjectOption = useCallback(
    (id: string) => {
      // selectProjectOption enforces selectability (worktree-only when
      // multiplicity is off, any project when it's on); don't re-gate here on
      // canCreateWorktree or non-git projects become unselectable.
      selectProjectOption(id);
      setProjectPickerOpen(false);
      clearManualPickerSelectionForTargetChange(selectedProjectOptionId, id);
    },
    [clearManualPickerSelectionForTargetChange, selectProjectOption, selectedProjectOptionId],
  );

  const handleSelectWorkspaceHost = useCallback(
    (id: string) => {
      handleSelectHost(id);
      clearManualPickerSelectionForTargetChange(selectedServerId, id);
    },
    [clearManualPickerSelectionForTargetChange, handleSelectHost, selectedServerId],
  );

  const handleAddProject = useCallback(() => {
    setProjectPickerOpen(false);
    openAddProjectPicker(selectedServerId);
  }, [openAddProjectPicker, selectedServerId]);

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

  const openIsolationPicker = useCallback(() => {
    setIsolationPickerOpen(true);
  }, []);

  const handleIsolationPickerOpenChange = useCallback((nextOpen: boolean) => {
    setIsolationPickerOpen(nextOpen);
  }, []);

  // "New worktree" is omitted entirely (not disabled) when the project isn't a
  // git checkout, since worktree isolation is impossible there.
  const isolationOptions = useMemo<ComboboxOptionType[]>(() => {
    const localOption = { id: "local", label: isolationLabel(t, "local") };
    if (!canCreateWorktree) return [localOption];
    return [localOption, { id: "worktree", label: isolationLabel(t, "worktree") }];
  }, [canCreateWorktree, t]);

  const handleSelectIsolationOption = useCallback(
    (id: string) => {
      setIsolation(id === "worktree" ? "worktree" : "local");
      setIsolationPickerOpen(false);
    },
    [setIsolation],
  );

  const renderIsolationOption = useCallback(
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
        <IsolationOptionItem
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
      if (!selectedSourceDirectory) {
        throw new Error("Choose a host for this project");
      }
      const checkoutRequest = resolveCheckoutRequest(selectedItem, currentBranch);
      const firstAgentContext = buildFirstAgentContext(input);

      return {
        cwd: selectedSourceDirectory,
        projectId: selectedProject.projectKey,
        worktreeSlug: createNameId(),
        ...(firstAgentContext ? { firstAgentContext } : {}),
        ...checkoutRequest,
      };
    },
    [currentBranch, selectedItem, selectedProject, selectedSourceDirectory],
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
      if (!selectedSourceDirectory) {
        throw new Error("Choose a host for this project");
      }
      const normalizedWorkspace = supportsWorkspaceMultiplicity
        ? await createMultiplicityWorkspace({
            client: withConnectedClient(),
            isolation: effectiveIsolation,
            project: selectedProject,
            sourceDirectory: selectedSourceDirectory,
            selectedItem,
            currentBranch,
            withInitialAgent: input.withInitialAgent,
            prompt: input.prompt,
            attachments: input.attachments,
            mergeWorkspaces,
            serverId: selectedServerId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          })
        : await createAndMergeWorkspace({
            client: withConnectedClient(),
            createInput: buildCreateWorktreeInput(input),
            mergeWorkspaces,
            serverId: selectedServerId,
            createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
          });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      buildCreateWorktreeInput,
      createdWorkspace,
      currentBranch,
      effectiveIsolation,
      mergeWorkspaces,
      selectedItem,
      selectedProject,
      selectedServerId,
      selectedSourceDirectory,
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
            serverId: selectedServerId,
            navigate: (targetServerId, workspaceId) =>
              navigateToWorkspace({ serverId: targetServerId, workspaceId }),
          });
          return;
        }

        setPendingAction("chat");
        await runCreateChatAgent({
          payload,
          composerState,
          forkDraftSetup,
          ensureWorkspace,
          serverId: selectedServerId,
          draftKey,
          draftId,
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
    [composerState, draftId, draftKey, ensureWorkspace, forkDraftSetup, selectedServerId, t, toast],
  );

  const renderPickerOption = useCallback(
    (props: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => <NewWorkspacePickerOption {...props} itemById={itemById} isPending={isPending} />,
    [isPending, itemById],
  );

  const renderProjectOption = useCallback(
    (props: {
      option: ComboboxOptionType;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <NewWorkspaceProjectPickerOption
        {...props}
        projectByOptionId={projectByOptionId}
        projectIconDataByProjectKey={projectIconDataByProjectKey}
        selectedServerId={selectedServerId}
        isPending={isPending}
        supportsWorkspaceMultiplicity={supportsWorkspaceMultiplicity}
      />
    ),
    [
      isPending,
      projectByOptionId,
      projectIconDataByProjectKey,
      selectedServerId,
      supportsWorkspaceMultiplicity,
    ],
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

  const formStack = useNewWorkspaceFormStack({
    isCompact,
    isPending,
    project: {
      anchorRef: projectPickerAnchorRef,
      open: openProjectPicker,
      options: projectPickerOptions,
      triggerLabel: projectTriggerLabel,
      selectedProject,
      iconDataByProjectKey: projectIconDataByProjectKey,
      selectedOptionId: selectedProjectOptionId,
      onSelect: handleSelectProjectOption,
      onAddProject: handleAddProject,
      openState: projectPickerOpen,
      onOpenChange: handleProjectPickerOpenChange,
      renderOption: renderProjectOption,
    },
    host: {
      allHosts,
      selectedServerId,
      onSelect: handleSelectWorkspaceHost,
      openState: hostPickerOpen,
      onOpenChange: handleHostPickerOpenChange,
      anchorRef: hostPickerAnchorRef,
      open: openHostPicker,
    },
    isolation: {
      anchorRef: isolationPickerAnchorRef,
      open: openIsolationPicker,
      effectiveIsolation,
      options: isolationOptions,
      onSelect: handleSelectIsolationOption,
      openState: isolationPickerOpen,
      onOpenChange: handleIsolationPickerOpenChange,
      renderOption: renderIsolationOption,
      canCreateWorktree,
    },
    base: {
      anchorRef: pickerAnchorRef,
      open: openPicker,
      selectedSourceDirectory,
      selectedItem,
      triggerLabel,
      options,
      selectedOptionId,
      onSelect: handleSelectOption,
      openState: pickerOpen,
      onOpenChange: handlePickerOpenChange,
      setSearchQuery: setPickerSearchQuery,
      emptyText: pickerEmptyText,
      renderOption: renderPickerOption,
      showRefPicker,
    },
  });

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
    <FileDropZone style={styles.container}>
      <ScreenHeader left={screenHeaderLeft} borderless />
      <View style={contentStyle}>
        <TitlebarDragRegion />
        <ReanimatedAnimated.View style={centeredStyle}>
          <View style={styles.composerTitleContainer}>
            <Text style={styles.composerTitle}>{t("newWorkspace.title")}</Text>
          </View>
          {formStack}
          <Composer
            externalKeyboardShift
            agentId={draftKey}
            serverId={selectedServerId}
            isPaneFocused={true}
            onSubmitMessage={handleSubmitNewWorkspace}
            allowEmptySubmit={true}
            submitButtonAccessibilityLabel={t("newWorkspace.create")}
            submitButtonTestID="workspace-create-submit"
            submitIcon="return"
            isSubmitLoading={isPending}
            submitBehavior="preserve-and-lock"
            blurOnSubmit={true}
            value={chatDraft.text}
            onChangeText={chatDraft.setText}
            attachments={chatDraft.attachments}
            attachmentScopeKeys={visibleDraftContextScopeKeys}
            onChangeAttachments={chatDraft.setAttachments}
            cwd={selectedSourceDirectory ?? ""}
            clearDraft={handleClearDraft}
            autoFocus
            commandDraftConfig={composerState?.commandDraftConfig}
            agentControls={agentControlsWithDisabled}
            footer={composerFooter}
          />
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        </ReanimatedAnimated.View>
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
  formStackDesktop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: theme.spacing[8],
    // The badge adds its own left padding; offset it so the project icon's left
    // edge lands exactly on the "New workspace" title's left edge.
    paddingLeft: theme.spacing[4],
    gap: theme.spacing[2],
  },
  // The row's left inset matches the heading's text x (composerTitleContainer
  // paddingLeft) so the control aligns with the "New workspace" glyph. The badge
  // adds its own left padding, so the row inset is reduced by that amount.
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[4],
    gap: theme.spacing[1],
  },
  baseSpacer: {
    height: BADGE_HEIGHT,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    height: BADGE_HEIGHT,
    maxWidth: 240,
    overflow: "hidden",
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
    minWidth: 0,
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
  hostStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
}));
