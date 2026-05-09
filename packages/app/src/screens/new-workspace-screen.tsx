import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { createNameId } from "mnemonic-id";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, GitBranch, GitPullRequest } from "lucide-react-native";
import { Composer } from "@/components/composer";
import { splitComposerAttachmentsForSubmit } from "@/components/composer-attachments";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { HEADER_INNER_HEIGHT, MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import type { ImageAttachment, MessagePayload } from "@/components/message-input";
import type { AgentAttachment, GitHubSearchItem } from "@server/shared/messages";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import { isEmptyWorkspaceSubmission, runCreateEmptyWorkspace } from "./new-workspace-empty";
import { pickerItemToCheckoutRequest, type PickerItem } from "./new-workspace-picker-item";
import { syncPickerPrAttachment } from "./new-workspace-picker-state";

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory: string;
  displayName?: string;
}

interface PickerOptionData {
  options: ComboboxOptionType[];
  itemById: Map<string, PickerItem>;
}

interface PickerSelection {
  item: PickerItem;
  attachedPrNumber: number | null;
}

const BRANCH_OPTION_PREFIX = "branch:";
const PR_OPTION_PREFIX = "github-pr:";

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
  iconColor,
  iconSize,
}: {
  pickerAnchorRef: React.RefObject<View | null>;
  onPress: () => void;
  disabled: boolean;
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
  selectedItem: PickerItem | null;
  triggerLabel: string;
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
          accessibilityLabel="Starting ref"
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
        <Text style={styles.tooltipText}>Choose where to start from</Text>
      </TooltipContent>
    </Tooltip>
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

function branchOptionId(name: string): string {
  return `${BRANCH_OPTION_PREFIX}${name}`;
}

function prOptionId(number: number): string {
  return `${PR_OPTION_PREFIX}${number}`;
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
}): Promise<ReturnType<typeof normalizeWorkspaceDescriptor>> {
  const payload = await input.client.createPaseoWorktree(input.createInput);
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "Failed to create worktree");
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  input.mergeWorkspaces(input.serverId, [normalizedWorkspace]);
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
}

async function runCreateChatAgent(input: CreateChatAgentInput): Promise<void> {
  const { payload, composerState, ensureWorkspace, serverId, draftKey } = input;
  const { text, attachments, cwd } = payload;
  if (!composerState) {
    throw new Error("Composer state is required");
  }
  const provider = composerState.selectedProvider;
  if (!provider) {
    throw new Error("Select a model");
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
  sourceDirectory: string;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, isConnected, workspaceDirectory, sourceDirectory } = input;
  return {
    initialServerId: serverId || null,
    initialValues: workspaceDirectory ? { workingDir: workspaceDirectory } : undefined,
    isVisible: true,
    onlineServerIds: isConnected && serverId ? [serverId] : [],
    lockedWorkingDir: workspaceDirectory || sourceDirectory || undefined,
  };
}

function computeWorkspaceTitle(
  workspace: ReturnType<typeof normalizeWorkspaceDescriptor> | null,
  displayName: string,
  sourceDirectory: string,
): string {
  return (
    workspace?.name ||
    workspace?.projectDisplayName ||
    displayName ||
    sourceDirectory.split(/[\\/]/).findLast(Boolean) ||
    sourceDirectory
  );
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
  useDraftStore.getState().saveDraftInput({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId: draftId,
      draftId,
    }),
    draft: {
      text,
      attachments: attachments.filter(
        (attachment): attachment is UserComposerAttachment => attachment.kind !== "review",
      ),
      cwd: workspaceDirectory,
    },
  });
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId,
    workspaceId,
    draftId,
    text,
    attachments,
    cwd: workspaceDirectory,
    provider,
    ...(composerState.modeOptions.length > 0 && composerState.selectedMode !== ""
      ? { modeId: composerState.selectedMode }
      : {}),
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
  sourceDirectory,
  displayName: displayNameProp,
}: NewWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });
  const toast = useToast();
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<ReturnType<
    typeof normalizeWorkspaceDescriptor
  > | null>(null);
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | null>(null);
  const [pickerSelection, setPickerSelection] = useState<PickerSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const pickerAnchorRef = useRef<View>(null);

  useEffect(() => {
    const trimmed = pickerSearchQuery.trim();
    const timer = setTimeout(() => setDebouncedPickerSearchQuery(trimmed), 180);
    return () => clearTimeout(timer);
  }, [pickerSearchQuery]);

  const displayName = displayNameProp?.trim() ?? "";
  const workspace = createdWorkspace;
  const selectedItem = pickerSelection?.item ?? null;
  const isPending = pendingAction !== null;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftKey = `new-workspace:${serverId}:${sourceDirectory}`;
  const chatDraft = useAgentInputDraft({
    draftKey,
    initialCwd: sourceDirectory,
    composer: buildComposerConfig({
      serverId,
      isConnected,
      workspaceDirectory: workspace?.workspaceDirectory ?? null,
      sourceDirectory,
    }),
  });
  const composerState = chatDraft.composerState;

  const withConnectedClient = useCallback(() => {
    if (!client || !isConnected) {
      throw new Error("Host is not connected");
    }
    return client;
  }, [client, isConnected]);

  const clientReady = isConnected && Boolean(client);
  const pickerQueryEnabled = pickerOpen && clientReady;

  const checkoutStatusQuery = useQuery({
    queryKey: ["checkout-status", serverId, sourceDirectory],
    queryFn: async () => {
      const connectedClient = withConnectedClient();
      return connectedClient.getCheckoutStatus(sourceDirectory);
    },
    enabled: clientReady,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const currentBranch = checkoutStatusQuery.data?.currentBranch ?? null;

  const branchSuggestionsQuery = useQuery({
    queryKey: ["branch-suggestions", serverId, sourceDirectory, debouncedPickerSearchQuery],
    queryFn: async () => {
      const connectedClient = withConnectedClient();
      return connectedClient.getBranchSuggestions({
        cwd: sourceDirectory,
        query: debouncedPickerSearchQuery || undefined,
        limit: 20,
      });
    },
    enabled: pickerQueryEnabled,
    staleTime: 15_000,
  });

  const githubPrSearchQuery = useQuery({
    queryKey: ["new-workspace-github-prs", serverId, sourceDirectory, debouncedPickerSearchQuery],
    queryFn: async () => {
      const connectedClient = withConnectedClient();
      return connectedClient.searchGitHub({
        cwd: sourceDirectory,
        query: debouncedPickerSearchQuery,
        limit: 20,
        kinds: ["github-pr"],
      });
    },
    enabled: pickerQueryEnabled,
    staleTime: 30_000,
  });

  const branchDetails = useMemo(() => {
    const details = branchSuggestionsQuery.data?.branchDetails;
    if (details && details.length > 0) return details;
    const names = branchSuggestionsQuery.data?.branches ?? [];
    return names.map((name) => ({ name, committerDate: 0 }));
  }, [branchSuggestionsQuery.data?.branchDetails, branchSuggestionsQuery.data?.branches]);
  const githubFeaturesEnabled = githubPrSearchQuery.data?.githubFeaturesEnabled !== false;
  const prItems: GitHubSearchItem[] = useMemo(() => {
    if (!githubFeaturesEnabled) return [];
    const items = githubPrSearchQuery.data?.items ?? [];
    return items.filter((item): item is GitHubSearchItem => item.kind === "pr");
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

  const handleSelectOption = useCallback(
    (id: string) => {
      const item = itemById.get(id);
      if (!item) return;

      const next = syncPickerPrAttachment({
        attachments: chatDraft.attachments,
        previousPickerPrNumber: pickerSelection?.attachedPrNumber ?? null,
        item,
      });

      setPickerSelection({
        item,
        attachedPrNumber: next.attachedPrNumber,
      });
      if (next.attachments !== chatDraft.attachments) {
        chatDraft.setAttachments(next.attachments);
      }
      setPickerOpen(false);
    },
    [chatDraft, itemById, pickerSelection?.attachedPrNumber],
  );

  const openPicker = useCallback(() => {
    setPickerOpen(true);
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

  const buildCreateWorktreeInput = useCallback(
    (input: { cwd: string; prompt: string; attachments: AgentAttachment[] }) => {
      const checkoutRequest = pickerItemToCheckoutRequest(selectedItem);
      const trimmedPrompt = input.prompt.trim();
      const hasFirstAgentContext = trimmedPrompt.length > 0 || input.attachments.length > 0;

      return {
        cwd: input.cwd,
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
    [selectedItem],
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
      });
      setCreatedWorkspace(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [buildCreateWorktreeInput, createdWorkspace, mergeWorkspaces, serverId, withConnectedClient],
  );

  const handleSubmitNewWorkspace = useCallback(
    async (payload: MessagePayload) => {
      try {
        setErrorMessage(null);
        if (isEmptyWorkspaceSubmission(payload)) {
          setPendingAction("empty");
          await runCreateEmptyWorkspace({
            payload,
            ensureWorkspace,
            serverId,
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
        });
      } catch (error) {
        const message = toErrorMessage(error);
        setPendingAction(null);
        setErrorMessage(message);
        toast.error(message);
      }
    },
    [composerState, draftKey, ensureWorkspace, serverId, toast],
  );

  const workspaceTitle = computeWorkspaceTitle(workspace, displayName, sourceDirectory);

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
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
        !isBranch && item.item.baseRefName ? `into ${item.item.baseRefName}` : undefined;

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
    [isPending, itemById, theme.colors.foregroundMuted, theme.iconSize.sm],
  );

  const contentStyle = useMemo(
    () => [
      styles.content,
      isCompact ? styles.contentCompact : styles.contentCentered,
      isCompact ? { paddingBottom: insets.bottom } : null,
    ],
    [isCompact, insets.bottom],
  );

  const optionsRowStyle = useMemo(
    () => [styles.optionsRow, keyboardAnimatedStyle],
    [keyboardAnimatedStyle],
  );

  const statusControlsWithDisabled = useMemo(
    () =>
      composerState
        ? {
            ...composerState.statusControls,
            disabled: isPending,
          }
        : undefined,
    [composerState, isPending],
  );

  const pickerEmptyText =
    branchSuggestionsQuery.isFetching || githubPrSearchQuery.isFetching
      ? "Searching..."
      : "No matching refs.";

  return (
    <View style={styles.container}>
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            <View style={styles.headerTitleContainer}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                New workspace
              </Text>
              <Text style={styles.headerProjectTitle} numberOfLines={1}>
                {workspaceTitle}
              </Text>
            </View>
          </>
        }
        leftStyle={styles.headerLeft}
        borderless
      />
      <View style={contentStyle}>
        <TitlebarDragRegion />
        <View style={styles.centered}>
          <Composer
            agentId={`new-workspace:${serverId}:${sourceDirectory}`}
            serverId={serverId}
            isPaneFocused={true}
            onSubmitMessage={handleSubmitNewWorkspace}
            allowEmptySubmit={true}
            submitButtonAccessibilityLabel="Create"
            submitIcon="return"
            isSubmitLoading={pendingAction !== null}
            submitBehavior="preserve-and-lock"
            blurOnSubmit={true}
            value={chatDraft.text}
            onChangeText={chatDraft.setText}
            attachments={chatDraft.attachments}
            onChangeAttachments={chatDraft.setAttachments}
            cwd={chatDraft.cwd}
            clearDraft={handleClearDraft}
            autoFocus
            commandDraftConfig={composerState?.commandDraftConfig}
            statusControls={statusControlsWithDisabled}
            onAddImages={handleAddImagesCallback}
          />
          <Animated.View testID="new-workspace-ref-picker-row" style={optionsRowStyle}>
            <View>
              <RefPickerTrigger
                pickerAnchorRef={pickerAnchorRef}
                onPress={openPicker}
                disabled={isPending}
                badgePressableStyle={badgePressableStyle}
                selectedItem={selectedItem}
                triggerLabel={triggerLabel}
                iconColor={theme.colors.foregroundMuted}
                iconSize={theme.iconSize.sm}
              />
              <Combobox
                options={options}
                value={selectedOptionId}
                onSelect={handleSelectOption}
                searchable
                searchPlaceholder="Search branches and PRs"
                title="Start from"
                open={pickerOpen}
                onOpenChange={handlePickerOpenChange}
                onSearchQueryChange={setPickerSearchQuery}
                desktopPlacement="bottom-start"
                anchorRef={pickerAnchorRef}
                emptyText={pickerEmptyText}
                renderOption={renderPickerOption}
              />
            </View>
          </Animated.View>
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        </View>
      </View>
    </View>
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
  headerLeft: {
    gap: theme.spacing[2],
  },
  headerTitleContainer: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  headerProjectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
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
    paddingHorizontal: theme.spacing[4] + theme.spacing[4] - 6,
    marginTop: -theme.spacing[2],
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
  rowIconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
