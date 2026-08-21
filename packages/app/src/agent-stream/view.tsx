import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  Pressable,
  Platform,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useMutation } from "@tanstack/react-query";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Check, ChevronDown, X } from "lucide-react-native";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openSidePanelView } from "@/workspace-tabs/side-panel";
import {
  AssistantMessage,
  SpeakMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  TodoListCard,
  CompactionMarker,
  MessageOuterSpacingProvider,
  type InlinePathTarget,
} from "@/components/message";
import { PlanCard } from "@/components/plan-card";
import type { StreamItem } from "@/types/stream";
import type { PendingMessageSubmission } from "@/composer/submission/model";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { PendingPermission } from "@/types/shared";
import type {
  AgentCapabilityFlags,
  AgentPermissionAction,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useSessionStore } from "@/stores/session-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { useSettings } from "@/hooks/use-settings";
import type { ToastApi } from "@/components/toast-host";
import { returnToTimelineTail } from "./timeline-tail-navigation";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import { QuestionFormCard } from "@/components/question-form-card";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import { OverviewToolCallGroupView } from "@/tool-calls/detail-level/overview/view";
import { type AgentStreamRenderModel, buildAgentStreamRenderModel } from "./model";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { type StreamSegmentRenderers, type StreamViewportHandle } from "./strategy";
import { ChatOutlineRail } from "@/agent-stream/chat-outline/rail";
import { useChatOutline } from "@/agent-stream/chat-outline/use-chat-outline";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import {
  CompletedTurnFooterRow,
  TurnFooter,
  TURN_FOOTER_BOTTOM_SPACING,
  type AssistantTurnForkHandler,
  type InFlightTurnForkHandler,
  type TurnContentStrategy,
} from "./turn-footer";
import { resolveBottomOverlayTailInset } from "./bottom-overlay-inset";
import { layoutStream, type StreamLayoutItem } from "./layout";
import {
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./bottom-anchor-controller";
import { createAssistantImageOccurrenceKey } from "@/assistant-image/acquisition-cache";
import { AssistantSelectionCopySurface } from "@/assistant-selection-copy/surface";
import {
  AssistantFileLinkResolverProvider,
  normalizeInlinePathTarget,
} from "@/assistant-file-links";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type OpenFileDisposition,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useForkAgent } from "@/hooks/use-fork-agent";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { recordRenderProfileReasons } from "@/utils/render-profiler";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { projectCompletedResponseFolds } from "./completed-response-fold";
import { CompletedResponseFoldRow } from "./completed-response-fold-row";
import { useStreamHistoryWindow } from "./use-stream-history-window";

function renderLiveAuxiliaryNode(input: {
  pendingPermissions: ReactNode;
  turnFooter: ReactNode;
  bottomOverlayInset: number;
}): ReactNode {
  if (!input.pendingPermissions && !input.turnFooter && input.bottomOverlayInset === 0) {
    return null;
  }
  return (
    <>
      {input.turnFooter}
      {input.pendingPermissions ? (
        <View style={stylesheet.contentWrapper}>
          <View style={stylesheet.listHeaderContent}>{input.pendingPermissions}</View>
        </View>
      ) : null}
      {input.bottomOverlayInset > 0 ? (
        <BottomOverlayInset height={input.bottomOverlayInset} />
      ) : null}
    </>
  );
}

function BottomOverlayInset({ height }: { height: number }) {
  const style = useMemo(() => ({ height }), [height]);
  return <View style={style} />;
}

function renderPendingPermissionsNode(input: {
  pendingPermissions: PendingPermission[];
  client: DaemonClient | null;
}): ReactNode {
  if (input.pendingPermissions.length === 0) {
    return null;
  }
  return (
    <View style={stylesheet.permissionsContainer}>
      {input.pendingPermissions.map((permission) => (
        <PermissionRequestCard key={permission.key} permission={permission} client={input.client} />
      ))}
    </View>
  );
}

function renderStreamItemWithTurnFooter(input: {
  content: ReactNode;
  layoutItem: StreamLayoutItem;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}): ReactNode {
  if (!input.content) {
    return null;
  }

  const footerHost = input.layoutItem.completedFooter;
  const footer = footerHost ? (
    <CompletedTurnFooterRow
      strategy={input.strategy}
      items={footerHost.items}
      timing={footerHost.timing}
      startIndex={footerHost.startIndex}
      supportsTimelineCursor={input.supportsTimelineCursor}
      onForkAssistantTurn={input.onForkAssistantTurn}
    />
  ) : null;
  const content = (
    <StreamItemWrapper itemId={input.layoutItem.item.id} gapBelow={input.layoutItem.gapBelow}>
      {input.content}
    </StreamItemWrapper>
  );

  if (input.layoutItem.frameOrder === "footer-then-content") {
    return (
      <>
        {footer}
        {content}
      </>
    );
  }

  return (
    <>
      {content}
      {footer}
    </>
  );
}

function renderListEmptyComponent(input: {
  renderModel: AgentStreamRenderModel;
  emptyStateStyle: StyleProp<ViewStyle>;
  emptyText: string;
}): ReactNode {
  if (
    input.renderModel.boundary.hasVirtualizedHistory ||
    input.renderModel.boundary.hasMountedHistory ||
    input.renderModel.boundary.hasLiveHead ||
    input.renderModel.auxiliary.pendingPermissions ||
    input.renderModel.auxiliary.turnFooter
  ) {
    return null;
  }

  return (
    <View style={input.emptyStateStyle}>
      <Text style={stylesheet.emptyStateText}>{input.emptyText}</Text>
    </View>
  );
}

function renderHistoryStreamItem(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return input.renderStreamItem(layoutItem);
}

function renderLiveHeadStreamItem(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return input.renderStreamItem(layoutItem);
}

export interface AgentStreamViewHandle {
  scrollToBottom(reason?: BottomAnchorLocalRequest["reason"]): void;
  prepareForViewportChange(): void;
}

export interface AgentStreamViewProps {
  agentId: string;
  serverId?: string;
  context: AgentScreenAgent;
  streamItems: StreamItem[];
  streamHead?: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  pendingMessageSubmissions?: readonly PendingMessageSubmission[];
  turnPresentation: TurnPresentation;
  routeBottomAnchorRequest?: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady?: boolean;
  /** Tail space required by a transparent overlay rendered at the bottom edge. */
  bottomOverlayTailClearance?: number;
  toast?: ToastApi | null;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  readOnly?: boolean;
  historyPagination?: {
    hasOlder: boolean;
    isLoadingOlder: boolean;
    progressKey: string | null;
    onLoadOlder: () => boolean | Promise<boolean>;
  };
}

const AGENT_CAPABILITY_FLAG_KEYS: (keyof AgentCapabilityFlags)[] = [
  "supportsStreaming",
  "supportsSessionPersistence",
  "supportsDynamicModes",
  "supportsMcpServers",
  "supportsReasoningStream",
  "supportsToolInvocations",
  "supportsRewindConversation",
  "supportsRewindFiles",
  "supportsRewindBoth",
];

const EMPTY_STREAM_HEAD: StreamItem[] = [];

function useRetainedValue<T>(value: T, active: boolean): T {
  const retainedRef = useRef(value);
  if (active) {
    retainedRef.current = value;
  }
  return active ? value : retainedRef.current;
}
const EMPTY_PENDING_MESSAGE_SUBMISSIONS: readonly PendingMessageSubmission[] = [];
const GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT = 200;

const AgentStreamViewComponent = forwardRef<AgentStreamViewHandle, AgentStreamViewProps>(
  function AgentStreamView(
    {
      agentId,
      serverId,
      context,
      streamItems,
      streamHead: providedStreamHead,
      pendingPermissions,
      pendingMessageSubmissions = EMPTY_PENDING_MESSAGE_SUBMISSIONS,
      turnPresentation,
      routeBottomAnchorRequest = null,
      isAuthoritativeHistoryReady = true,
      bottomOverlayTailClearance = 0,
      toast,
      onOpenWorkspaceFile,
      readOnly = false,
      historyPagination,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const autoExpandReasoning = useSettings((settings) => settings.autoExpandReasoning);
    const toolCallDetailLevel = useSettings((settings) => settings.toolCallDetailLevel);
    const chatOutlineEnabled = useSettings((settings) => settings.chatOutlineEnabled);
    const viewportRef = useRef<StreamViewportHandle | null>(null);
    const pendingClientMessageIds = useMemo(
      () => new Set(pendingMessageSubmissions.map((submission) => submission.clientMessageId)),
      [pendingMessageSubmissions],
    );
    const isMobile = useIsCompactFormFactor();
    const streamRenderStrategy = useMemo(
      () =>
        resolveStreamRenderStrategy({
          platform: Platform.OS,
          isMobileBreakpoint: isMobile,
        }),
      [isMobile],
    );
    const [isNearBottom, setIsNearBottom] = useState(true);
    const [expandedInlineToolCallIds, setExpandedInlineToolCallIds] = useState<Set<string>>(
      new Set(),
    );
    const [expandedToolCallGroupIds, setExpandedToolCallGroupIds] = useState<Set<string>>(
      new Set(),
    );
    const [expandedCompletedResponseIds, setExpandedCompletedResponseIds] = useState<Set<string>>(
      new Set(),
    );

    // Get serverId (fallback to agent's serverId if not provided)
    const resolvedServerId = serverId ?? context.serverId ?? "";

    const client = useSessionStore((state) => state.sessions[resolvedServerId]?.client ?? null);
    const sessionStreamHead = useSessionStore((state) =>
      state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId),
    );
    const streamHead = providedStreamHead ?? sessionStreamHead;
    const forkAgent = useForkAgent({ serverId: resolvedServerId, toast, readOnly });
    const supportsAgentForkContextCursor = useSessionStore(
      (state) =>
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentForkContextCursor === true,
    );
    const supportsChatOutline = useSessionStore(
      (state) =>
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentTimelinePromptIndex === true,
    );
    const timelineEpoch = useSessionStore(
      (state) => state.sessions[resolvedServerId]?.agentTimelineCursor.get(agentId)?.epoch ?? null,
    );
    const isTimelineDetached = useSessionStore(
      (state) => state.sessions[resolvedServerId]?.agentTimelineHasNewer.get(agentId) === true,
    );

    const workspaceRoot = context.cwd?.trim() || "";
    const { requestDirectoryListing } = useFileExplorerActions({
      serverId: resolvedServerId,
      workspaceId: context.workspaceId,
      workspaceRoot,
    });
    const agentHistoryPagination = useLoadOlderAgentHistory({
      serverId: resolvedServerId,
      agentId,
      toast,
    });
    const {
      isLoadingOlder: remoteIsLoadingOlder,
      hasOlder: remoteHasOlder,
      progressKey: remoteProgressKey,
      loadOlder: loadRemoteOlder,
    } = historyPagination
      ? {
          isLoadingOlder: historyPagination.isLoadingOlder,
          hasOlder: historyPagination.hasOlder,
          progressKey: historyPagination.progressKey,
          loadOlder: historyPagination.onLoadOlder,
        }
      : agentHistoryPagination;
    // Keep entry/exit animations off on Android due to RN dispatchDraw crashes
    // tracked in react-native-reanimated#8422.
    const shouldDisableEntryExitAnimations = Platform.OS === "android";
    const scrollIndicatorFadeIn = shouldDisableEntryExitAnimations
      ? undefined
      : FadeIn.duration(200);
    const scrollIndicatorFadeOut = shouldDisableEntryExitAnimations
      ? undefined
      : FadeOut.duration(200);

    useEffect(() => {
      setIsNearBottom(true);
      setExpandedInlineToolCallIds(new Set());
      setExpandedToolCallGroupIds(new Set());
      setExpandedCompletedResponseIds(new Set());
    }, [agentId]);

    const handleInlinePathPress = useStableEvent(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        if (!target.path) {
          return;
        }

        const normalized = normalizeInlinePathTarget(target.path, context.cwd);
        if (!normalized) {
          return;
        }

        if (normalized.file) {
          const location = normalizeWorkspaceFileLocation({
            path: normalized.file,
            lineStart: target.lineStart,
            lineEnd: target.lineEnd,
          });
          if (!location) {
            return;
          }

          if (onOpenWorkspaceFile) {
            onOpenWorkspaceFile({
              location,
              disposition,
            });
            return;
          }

          if (context.workspaceId) {
            navigateToWorkspace({
              serverId: resolvedServerId,
              workspaceId: context.workspaceId,
              target: createWorkspaceFileTabTarget(location),
            });
          }
          return;
        }

        void requestDirectoryListing(normalized.directory, {
          recordHistory: false,
          setCurrentPath: false,
        });

        openSidePanelView({
          isCompact: isMobile,
          workspaceKey: buildWorkspaceTabPersistenceKey({
            serverId: resolvedServerId,
            workspaceId: context.workspaceId ?? "",
          }),
          checkout: {
            serverId: resolvedServerId,
            cwd: context.cwd,
            isGit: context.projectPlacement?.checkout?.isGit ?? true,
          },
          view: "files",
        });
      },
    );

    const handleToolCallOpenFile = useStableEvent((filePath: string) => {
      handleInlinePathPress({ raw: filePath, path: filePath }, "side");
    });

    const handleForkAssistantTurn: AssistantTurnForkHandler = useStableEvent(
      async ({ target, boundary }) => {
        await forkAgent({
          agentId,
          agent: context,
          workspaceId: context.workspaceId,
          target,
          boundary,
        });
      },
    );

    // The in-flight turn forks with no boundary at all: `selectForkContextRows`
    // projects the whole timeline when neither boundary field is given, so the
    // fork carries everything up to now, including the response still streaming
    // in front of the user.
    const handleForkInFlightTurn: InFlightTurnForkHandler = useStableEvent(async (target) => {
      await forkAgent({
        agentId,
        agent: context,
        workspaceId: context.workspaceId,
        target,
      });
    });

    // Freeze stream presentation while this tab slot is hidden to prevent offscreen
    // cell-window and turn-lifecycle renders from background agents.
    // When isActive flips back to true, the context change triggers a re-render and
    // the component reads the current (fresh) streamItems/streamHead from props.
    const isActive = useRetainedPanelActive();
    const effectiveStreamItems = useRetainedValue(streamItems, isActive);
    const effectiveStreamHead = useRetainedValue(streamHead, isActive);
    const effectiveTurnPresentation = useRetainedValue(turnPresentation, isActive);
    const isTurnActive = effectiveTurnPresentation.isActive;
    // Keep retained history outside the 48ms live-head flush path.
    const preparedToolCallHistory = useMemo(
      () => prepareToolCallHistory(toolCallDetailLevel, effectiveStreamItems),
      [effectiveStreamItems, toolCallDetailLevel],
    );
    const projectedToolCalls = useMemo(
      () =>
        projectToolCallDetailLevel({
          level: toolCallDetailLevel,
          tail: effectiveStreamItems,
          head: effectiveStreamHead ?? EMPTY_STREAM_HEAD,
          preparedHistory: preparedToolCallHistory,
          isTurnActive,
        }),
      [
        effectiveStreamHead,
        effectiveStreamItems,
        isTurnActive,
        preparedToolCallHistory,
        toolCallDetailLevel,
      ],
    );
    const {
      start: historyWindowStart,
      hasLocalHistory,
      revealLoadedHistory,
      loadOlder,
    } = useStreamHistoryWindow({
      agentId,
      items: projectedToolCalls.tail,
      loadRemoteOlder,
    });
    const isLoadingOlder = remoteIsLoadingOlder;
    const hasOlder = hasLocalHistory || remoteHasOlder;
    const progressKey = `${remoteProgressKey ?? "local"}:${historyWindowStart}`;
    const mountedToolCallTail = useMemo(
      () =>
        historyWindowStart > 0
          ? projectedToolCalls.tail.slice(historyWindowStart)
          : projectedToolCalls.tail,
      [historyWindowStart, projectedToolCalls.tail],
    );
    const completedResponseProjection = useMemo(
      () =>
        projectCompletedResponseFolds({
          tail: mountedToolCallTail,
          head: projectedToolCalls.head,
          isTurnActive,
          expandedResponseIds: expandedCompletedResponseIds,
          preserveLeadingResponse: hasOlder,
        }),
      [
        expandedCompletedResponseIds,
        hasOlder,
        isTurnActive,
        mountedToolCallTail,
        projectedToolCalls.head,
      ],
    );

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        isTurnActive,
        activeTurnStartedAt: effectiveTurnPresentation.startedAt,
        tail: completedResponseProjection.tail,
        head: completedResponseProjection.head,
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
      });
    }, [
      isMobile,
      isTurnActive,
      completedResponseProjection.head,
      completedResponseProjection.tail,
      effectiveTurnPresentation.startedAt,
    ]);
    const streamLayout = useMemo(
      () =>
        layoutStream({
          strategy: streamRenderStrategy,
          isTurnActive,
          history: baseRenderModel.history,
          liveHead: baseRenderModel.segments.liveHead,
          timingByAssistantId: baseRenderModel.turnTiming.byAssistantId,
        }),
      [
        baseRenderModel.history,
        baseRenderModel.segments.liveHead,
        baseRenderModel.turnTiming.byAssistantId,
        isTurnActive,
        streamRenderStrategy,
      ],
    );
    const handleTimelineHistoryLoadError = useCallback(() => {
      toast?.error(t("agentStream.historyLoadFailed"));
    }, [t, toast]);
    const visibleHistoryItemIds = useMemo(
      () =>
        new Set(
          [...baseRenderModel.history, ...baseRenderModel.segments.liveHead].map((item) => item.id),
        ),
      [baseRenderModel.history, baseRenderModel.segments.liveHead],
    );
    const chatOutline = useChatOutline({
      agentId,
      serverId: resolvedServerId,
      timelineEpoch,
      tail: effectiveStreamItems,
      head: effectiveStreamHead,
      enabled: supportsChatOutline && chatOutlineEnabled,
      viewportRef,
      onJumpError: handleTimelineHistoryLoadError,
      visibleItemIds: visibleHistoryItemIds,
      revealLoadedItem: revealLoadedHistory,
    });

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom(reason = "jump-to-bottom") {
          viewportRef.current?.scrollToBottom(reason);
        },
        prepareForViewportChange() {
          viewportRef.current?.prepareForViewportChange();
        },
      }),
      [],
    );

    const scrollToBottom = useCallback(() => {
      if (!isTimelineDetached) {
        viewportRef.current?.scrollToBottom("jump-to-bottom");
        return;
      }
      void returnToTimelineTail({
        fetchTail: () =>
          getHostRuntimeStore().fetchAgentTimeline(resolvedServerId, agentId, {
            ...planTimelineTailFetch(),
          }),
        scrollToBottom: () => viewportRef.current?.scrollToBottom("jump-to-bottom"),
        onError: handleTimelineHistoryLoadError,
      });
    }, [agentId, handleTimelineHistoryLoadError, isTimelineDetached, resolvedServerId]);

    const setInlineDetailsExpanded = useCallback(
      (itemId: string, expanded: boolean) => {
        if (!streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion()) {
          return;
        }
        setExpandedInlineToolCallIds((previous) => {
          const next = new Set(previous);
          if (expanded) {
            next.add(itemId);
          } else {
            next.delete(itemId);
          }
          return next;
        });
      },
      [streamRenderStrategy],
    );

    const setToolCallGroupExpanded = useCallback((groupId: string, expanded: boolean) => {
      setExpandedToolCallGroupIds((previous) => {
        const next = new Set(previous);
        if (expanded) {
          next.add(groupId);
        } else {
          next.delete(groupId);
        }
        return next;
      });
    }, []);

    const toggleCompletedResponse = useCallback((responseId: string) => {
      setExpandedCompletedResponseIds((previous) => {
        const next = new Set(previous);
        if (next.has(responseId)) {
          next.delete(responseId);
        } else {
          next.add(responseId);
        }
        return next;
      });
    }, []);

    const renderUserMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "user_message" }>) => {
        return (
          <UserMessage
            serverId={resolvedServerId}
            agentId={agentId}
            messageId={item.messageId}
            message={item.text}
            images={item.images}
            attachments={item.attachments}
            timestamp={item.timestamp.getTime()}
            capabilities={context.capabilities}
            client={client}
            isFirstInGroup={layoutItem.isFirstInUserGroup}
            isLastInGroup={layoutItem.isLastInUserGroup}
            isPending={
              item.clientMessageId !== undefined &&
              pendingClientMessageIds.has(item.clientMessageId)
            }
          />
        );
      },
      [context.capabilities, agentId, client, pendingClientMessageIds, resolvedServerId],
    );

    const renderAssistantMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "assistant_message" }>) => {
        return (
          <AssistantFileLinkResolverProvider
            client={client}
            serverId={resolvedServerId}
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={handleInlinePathPress}
            toast={toast}
          >
            <AssistantMessage
              occurrenceKey={createAssistantImageOccurrenceKey({ agentId, itemId: item.id })}
              message={item.text}
              timestamp={item.timestamp.getTime()}
              workspaceRoot={workspaceRoot}
              serverId={resolvedServerId}
              client={client}
              spacing={layoutItem.assistantSpacing}
              phase={layoutItem.phase}
            />
          </AssistantFileLinkResolverProvider>
        );
      },
      [agentId, client, handleInlinePathPress, resolvedServerId, toast, workspaceRoot],
    );

    const renderThoughtItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "thought" }>) => {
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName="thinking"
            args={item.text}
            status={item.status === "ready" ? "completed" : "executing"}
            isLastInSequence={layoutItem.isLastInToolSequence}
            defaultExpanded={autoExpandReasoning}
            forceInline={autoExpandReasoning}
          />
        );
      },
      [autoExpandReasoning, setInlineDetailsExpanded],
    );

    const renderSingleToolCallItem = useCallback(
      (
        item: Extract<StreamItem, { kind: "tool_call" }>,
        isLastInSequence: boolean,
        maxDetailHeight?: number,
      ) => {
        const { payload } = item;

        if (payload.source === "agent") {
          const data = payload.data;

          if (
            data.name === "speak" &&
            data.detail.type === "unknown" &&
            typeof data.detail.input === "string" &&
            data.detail.input.trim()
          ) {
            return (
              <SpeakMessage message={data.detail.input} timestamp={item.timestamp.getTime()} />
            );
          }

          return (
            <ToolCallSlot
              itemId={item.id}
              onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
              toolName={data.name}
              error={data.error}
              status={data.status}
              detail={data.detail}
              cwd={context.cwd}
              metadata={data.metadata}
              isLastInSequence={isLastInSequence}
              onOpenFilePath={handleToolCallOpenFile}
              maxDetailHeight={maxDetailHeight}
            />
          );
        }

        const data = payload.data;
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName={data.toolName}
            args={data.arguments}
            result={data.result}
            status={data.status}
            isLastInSequence={isLastInSequence}
            onOpenFilePath={handleToolCallOpenFile}
            maxDetailHeight={maxDetailHeight}
          />
        );
      },
      [context.cwd, setInlineDetailsExpanded, handleToolCallOpenFile],
    );

    const renderToolCallItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "tool_call" }>) => {
        const group = projectedToolCalls.groupsByHostId.get(item.id);
        if (!group) {
          return renderSingleToolCallItem(item, layoutItem.isLastInToolSequence);
        }
        const expanded = expandedToolCallGroupIds.has(group.run.id);
        return (
          <OverviewToolCallGroupView
            group={group}
            expanded={expanded}
            isLastInSequence={layoutItem.isLastInToolSequence}
            onExpandedChange={setToolCallGroupExpanded}
          >
            {expanded
              ? group.run.calls.map((call, index) => (
                  <React.Fragment key={call.id}>
                    {renderSingleToolCallItem(
                      call,
                      index === group.run.calls.length - 1,
                      GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT,
                    )}
                  </React.Fragment>
                ))
              : null}
          </OverviewToolCallGroupView>
        );
      },
      [
        projectedToolCalls.groupsByHostId,
        expandedToolCallGroupIds,
        renderSingleToolCallItem,
        setToolCallGroupExpanded,
      ],
    );

    const renderStreamItemContent = useCallback(
      (layoutItem: StreamLayoutItem) => {
        const item = layoutItem.item;
        const fold = completedResponseProjection.foldsByAnchorItemId.get(item.id);
        let content: ReactNode;
        switch (item.kind) {
          case "user_message":
            content = renderUserMessageItem(layoutItem, item);
            break;

          case "assistant_message":
            content = renderAssistantMessageItem(layoutItem, item);
            break;

          case "thought":
            content = renderThoughtItem(layoutItem, item);
            break;

          case "tool_call":
            content = renderToolCallItem(layoutItem, item);
            break;

          case "activity_log":
            content = (
              <ActivityLog
                type={item.activityType}
                message={item.message}
                timestamp={item.timestamp.getTime()}
                metadata={item.metadata}
              />
            );
            break;

          case "todo_list":
            content = <TodoListCard items={item.items} activity={item.activity} />;
            break;

          case "compaction":
            content = (
              <CompactionMarker
                status={item.status}
                trigger={item.trigger}
                preTokens={item.preTokens}
              />
            );
            break;

          default:
            content = null;
        }

        if (!fold) {
          return content;
        }
        return (
          <CompletedResponseFoldRow fold={fold} onToggle={toggleCompletedResponse}>
            {content}
          </CompletedResponseFoldRow>
        );
      },
      [
        completedResponseProjection.foldsByAnchorItemId,
        renderUserMessageItem,
        renderAssistantMessageItem,
        renderThoughtItem,
        renderToolCallItem,
        toggleCompletedResponse,
      ],
    );

    const bottomTurnFooterHost = streamLayout.auxiliaryTurnFooter;

    const renderStreamItem = useCallback(
      (layoutItem: StreamLayoutItem) => {
        const content = renderStreamItemContent(layoutItem);
        return renderStreamItemWithTurnFooter({
          content,
          layoutItem,
          strategy: streamRenderStrategy,
          supportsTimelineCursor: supportsAgentForkContextCursor,
          onForkAssistantTurn: readOnly ? undefined : handleForkAssistantTurn,
        });
      },
      [
        handleForkAssistantTurn,
        readOnly,
        renderStreamItemContent,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const pendingPermissionsNode = useMemo(
      () =>
        renderPendingPermissionsNode({
          pendingPermissions: pendingPermissionItems,
          client,
        }),
      [client, pendingPermissionItems],
    );
    const turnFooterNode = useMemo(
      () =>
        isTurnActive || bottomTurnFooterHost ? (
          <TurnFooter
            isRunning={isTurnActive}
            inFlightTurnStartedAt={baseRenderModel.turnTiming.runningStartedAt}
            host={bottomTurnFooterHost}
            strategy={streamRenderStrategy}
            supportsTimelineCursor={supportsAgentForkContextCursor}
            onForkAssistantTurn={readOnly ? undefined : handleForkAssistantTurn}
            onForkInFlightTurn={readOnly ? undefined : handleForkInFlightTurn}
          />
        ) : null,
      [
        handleForkAssistantTurn,
        handleForkInFlightTurn,
        readOnly,
        isTurnActive,
        baseRenderModel.turnTiming.runningStartedAt,
        bottomTurnFooterHost,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      return {
        ...baseRenderModel,
        boundary: baseRenderModel.boundary,
        auxiliary: {
          pendingPermissions: pendingPermissionsNode,
          turnFooter: turnFooterNode,
        },
      };
    }, [baseRenderModel, pendingPermissionsNode, turnFooterNode]);

    const emptyStateStyle = useMemo(() => [stylesheet.emptyState, stylesheet.contentWrapper], []);
    const listEmptyComponent = useMemo(
      () =>
        renderListEmptyComponent({
          renderModel,
          emptyStateStyle,
          emptyText: t("agentStream.empty"),
        }),
      [renderModel, emptyStateStyle, t],
    );

    const { boundary, auxiliary } = renderModel;

    const layoutHistoryItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.history) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.history]);

    const layoutLiveHeadItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.liveHead) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.liveHead]);

    const renderHistoryRow = useCallback(
      (item: StreamItem) =>
        renderHistoryStreamItem({
          item,
          layoutItemById: layoutHistoryItemById,
          renderStreamItem,
        }),
      [layoutHistoryItemById, renderStreamItem],
    );

    const renderHistoryVirtualizedRow = useCallback<
      StreamSegmentRenderers["renderHistoryVirtualizedRow"]
    >((item) => renderHistoryRow(item), [renderHistoryRow]);
    const renderHistoryMountedRow = useCallback<StreamSegmentRenderers["renderHistoryMountedRow"]>(
      (item) => renderHistoryRow(item),
      [renderHistoryRow],
    );
    // useStableEvent keeps the function reference stable across flushes.
    // layoutLiveHeadItemById and renderStreamItem are read from the ref at call time,
    // so the live-head render always uses the latest layout without causing renderers
    // to be a new object on every text-chunk flush.
    const renderLiveHeadRow: StreamSegmentRenderers["renderLiveHeadRow"] = useStableEvent(
      (item: StreamItem) =>
        renderLiveHeadStreamItem({
          item,
          layoutItemById: layoutLiveHeadItemById,
          renderStreamItem,
        }),
    );
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      const existingTailSpacing =
        auxiliary.turnFooter && !auxiliary.pendingPermissions ? TURN_FOOTER_BOTTOM_SPACING : 0;
      const bottomOverlayInset = resolveBottomOverlayTailInset({
        requiredTailClearance: bottomOverlayTailClearance,
        existingTailSpacing,
      });
      return renderLiveAuxiliaryNode({
        pendingPermissions: auxiliary.pendingPermissions,
        turnFooter: auxiliary.turnFooter,
        bottomOverlayInset,
      });
    }, [auxiliary.pendingPermissions, auxiliary.turnFooter, bottomOverlayTailClearance]);

    const renderers = useMemo<StreamSegmentRenderers>(
      () => ({
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      }),
      [
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      ],
    );

    const streamScrollEnabled =
      !streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion() ||
      expandedInlineToolCallIds.size === 0;
    const historyRowRevision = useMemo(
      () => ({
        contentById: projectedToolCalls.historyGroupUpdatesByHostId,
        displayStateById: expandedToolCallGroupIds,
        globalDisplayState: isMobile,
      }),
      [expandedToolCallGroupIds, isMobile, projectedToolCalls.historyGroupUpdatesByHostId],
    );

    return (
      <ToolCallSheetProvider>
        <AssistantSelectionCopySurface style={stylesheet.container}>
          <MessageOuterSpacingProvider disableOuterSpacing>
            {streamRenderStrategy.render({
              agentId,
              segments: renderModel.segments,
              historyRowRevision,
              liveHeadRowRevision: expandedToolCallGroupIds,
              boundary,
              renderers,
              listEmptyComponent,
              viewportRef,
              routeBottomAnchorRequest,
              isAuthoritativeHistoryReady,
              onNearBottomChange: setIsNearBottom,
              onReadingPositionChange: chatOutline.reportReadingPosition,
              onNearHistoryStart: loadOlder,
              isLoadingOlderHistory: isLoadingOlder,
              hasOlderHistory: hasOlder,
              olderHistoryProgressKey: progressKey,
              scrollEnabled: streamScrollEnabled,
              listStyle: stylesheet.list,
              baseListContentContainerStyle: stylesheet.listContentContainer,
              forwardListContentContainerStyle: stylesheet.forwardListContentContainer,
            })}
          </MessageOuterSpacingProvider>
          <ChatOutlineRail
            prompts={chatOutline.prompts}
            activePrompt={chatOutline.activePrompt}
            onJumpToPrompt={chatOutline.jumpToPrompt}
          />
          {(!isNearBottom || isTimelineDetached) && (
            <View style={stylesheet.scrollToBottomContainer} pointerEvents="box-none">
              <Animated.View entering={scrollIndicatorFadeIn} exiting={scrollIndicatorFadeOut}>
                <Pressable
                  style={stylesheet.scrollToBottomButton}
                  onPress={scrollToBottom}
                  accessibilityRole="button"
                  accessibilityLabel={t("agentStream.scrollToBottom")}
                  testID="scroll-to-bottom-button"
                >
                  <ChevronDown size={24} color={stylesheet.scrollToBottomIcon.color} />
                </Pressable>
              </Animated.View>
            </View>
          )}
        </AssistantSelectionCopySurface>
      </ToolCallSheetProvider>
    );
  },
);

function agentCapabilityFlagsEqual(
  left: AgentCapabilityFlags | undefined,
  right: AgentCapabilityFlags | undefined,
): boolean {
  return AGENT_CAPABILITY_FLAG_KEYS.every((key) => left?.[key] === right?.[key]);
}

function collectAgentProjectPlacementDiffs(
  left: AgentScreenAgent["projectPlacement"],
  right: AgentScreenAgent["projectPlacement"],
): string[] {
  const reasons: string[] = [];
  if (left?.checkout?.cwd !== right?.checkout?.cwd) {
    reasons.push("agent.projectPlacement.checkout.cwd");
  }
  if (left?.checkout?.isGit !== right?.checkout?.isGit) {
    reasons.push("agent.projectPlacement.checkout.isGit");
  }
  if (left?.projectName !== right?.projectName) {
    reasons.push("agent.projectPlacement.projectName");
  }
  if (left?.projectKey !== right?.projectKey) {
    reasons.push("agent.projectPlacement.projectKey");
  }
  return reasons;
}

function collectAgentSetupDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.provider !== right.provider) reasons.push("agent.provider");
  if (left.currentModeId !== right.currentModeId) reasons.push("agent.currentModeId");
  if (left.model !== right.model) reasons.push("agent.model");
  if (left.thinkingOptionId !== right.thinkingOptionId) {
    reasons.push("agent.thinkingOptionId");
  }
  if (left.runtimeInfo?.modeId !== right.runtimeInfo?.modeId) {
    reasons.push("agent.runtimeInfo.modeId");
  }
  if (left.runtimeInfo?.model !== right.runtimeInfo?.model) {
    reasons.push("agent.runtimeInfo.model");
  }
  if (left.runtimeInfo?.thinkingOptionId !== right.runtimeInfo?.thinkingOptionId) {
    reasons.push("agent.runtimeInfo.thinkingOptionId");
  }
  if (left.features !== right.features) reasons.push("agent.features");
  return reasons;
}

function collectAgentScreenAgentDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.serverId !== right.serverId) reasons.push("agent.serverId");
  if (left.id !== right.id) reasons.push("agent.id");
  if (left.workspaceId !== right.workspaceId) reasons.push("agent.workspaceId");
  if (left.status !== right.status) reasons.push("agent.status");
  if (left.cwd !== right.cwd) reasons.push("agent.cwd");
  if (!agentCapabilityFlagsEqual(left.capabilities, right.capabilities)) {
    reasons.push("agent.capabilities");
  }
  if (left.lastError !== right.lastError) reasons.push("agent.lastError");
  reasons.push(...collectAgentSetupDiffs(left, right));
  reasons.push(...collectAgentProjectPlacementDiffs(left.projectPlacement, right.projectPlacement));
  return reasons;
}

function bottomAnchorRouteRequestsEqual(
  left: BottomAnchorRouteRequest | null | undefined,
  right: BottomAnchorRouteRequest | null | undefined,
): boolean {
  return (
    left?.agentId === right?.agentId &&
    left?.reason === right?.reason &&
    left?.requestKey === right?.requestKey
  );
}

function historyPaginationPropsEqual(
  left: AgentStreamViewProps["historyPagination"],
  right: AgentStreamViewProps["historyPagination"],
): boolean {
  return (
    left?.hasOlder === right?.hasOlder &&
    left?.isLoadingOlder === right?.isLoadingOlder &&
    left?.progressKey === right?.progressKey &&
    left?.onLoadOlder === right?.onLoadOlder
  );
}

function agentStreamViewPropsEqual(
  left: AgentStreamViewProps,
  right: AgentStreamViewProps,
): boolean {
  const reasons: string[] = [];
  if (left.agentId !== right.agentId) reasons.push("agentId");
  if (left.serverId !== right.serverId) reasons.push("serverId");
  reasons.push(...collectAgentScreenAgentDiffs(left.context, right.context));
  if (left.streamItems !== right.streamItems) reasons.push("streamItems");
  if (left.streamHead !== right.streamHead) reasons.push("streamHead");
  if (left.pendingPermissions !== right.pendingPermissions) reasons.push("pendingPermissions");
  if (left.pendingMessageSubmissions !== right.pendingMessageSubmissions) {
    reasons.push("pendingMessageSubmissions");
  }
  if (left.turnPresentation !== right.turnPresentation) reasons.push("turnPresentation");
  if (
    !bottomAnchorRouteRequestsEqual(left.routeBottomAnchorRequest, right.routeBottomAnchorRequest)
  ) {
    reasons.push("routeBottomAnchorRequest");
  }
  if (left.isAuthoritativeHistoryReady !== right.isAuthoritativeHistoryReady) {
    reasons.push("isAuthoritativeHistoryReady");
  }
  if (left.toast !== right.toast) reasons.push("toast");
  if (left.onOpenWorkspaceFile !== right.onOpenWorkspaceFile) reasons.push("onOpenWorkspaceFile");
  if (left.readOnly !== right.readOnly) reasons.push("readOnly");
  if (!historyPaginationPropsEqual(left.historyPagination, right.historyPagination)) {
    reasons.push("historyPagination");
  }
  recordRenderProfileReasons(`AgentStreamView:${right.agentId}`, reasons);
  return reasons.length === 0;
}

export const AgentStreamView = memo(AgentStreamViewComponent, agentStreamViewPropsEqual);
AgentStreamView.displayName = "AgentStreamView";

interface ToolCallSlotProps extends Omit<
  ComponentProps<typeof ToolCall>,
  "onInlineDetailsExpandedChange"
> {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (itemId: string, expanded: boolean) => void;
}

function ToolCallSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  ...rest
}: ToolCallSlotProps) {
  const handleExpandedChange = useCallback(
    (expanded: boolean) => onInlineDetailsExpandedChangeByItemId(itemId, expanded),
    [onInlineDetailsExpandedChangeByItemId, itemId],
  );
  return <ToolCall {...rest} onInlineDetailsExpandedChange={handleExpandedChange} />;
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedCheckIcon = withUnistyles(Check);
const ThemedXIcon = withUnistyles(X);

const primaryColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const pressableStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  permissionStyles.optionButton,
  hovered ? permissionStyles.optionButtonHovered : null,
  pressed ? permissionStyles.optionButtonPressed : null,
];

interface PermissionActionButtonProps {
  action: AgentPermissionAction;
  isRespondingAction: boolean;
  isResponding: boolean;
  isPrimary: boolean;
  Icon: typeof ThemedCheckIcon;
  testID: string;
  onPress: (action: AgentPermissionAction) => void;
}

function PermissionActionButton({
  action,
  isRespondingAction,
  isResponding,
  isPrimary,
  Icon,
  testID,
  onPress,
}: PermissionActionButtonProps) {
  const handlePress = useCallback(() => onPress(action), [onPress, action]);
  const optionTextStyle = isPrimary
    ? [permissionStyles.optionText, permissionStyles.optionTextPrimary]
    : permissionStyles.optionText;
  const colorMapping = isPrimary ? primaryColorMapping : mutedColorMapping;
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
    >
      {isRespondingAction ? (
        <ThemedLoadingSpinner size="small" uniProps={colorMapping} />
      ) : (
        <View style={permissionStyles.optionContent}>
          <Icon size={14} uniProps={colorMapping} />
          <Text style={optionTextStyle}>{action.label}</Text>
        </View>
      )}
    </Pressable>
  );
}

function PermissionRequestCard({
  permission,
  client,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest
    ? t("agentStream.permission.plan")
    : (request.title ?? request.name ?? t("agentStream.permission.required"));
  const description = request.description ?? "";
  const resolvedToolCallDetail = useMemo(
    () =>
      request.detail ?? {
        type: "unknown" as const,
        input: request.input ?? null,
        output: null,
      },
    [request.detail, request.input],
  );
  const resolvedActions = useMemo((): AgentPermissionAction[] => {
    if (request.kind === "question") {
      return [];
    }
    if (Array.isArray(request.actions) && request.actions.length > 0) {
      return request.actions;
    }
    return [
      {
        id: "reject",
        label: t("agentStream.permission.deny"),
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      },
      {
        id: "accept",
        label: isPlanRequest
          ? t("agentStream.permission.implement")
          : t("agentStream.permission.accept"),
        behavior: "allow",
        variant: "primary",
      },
    ];
  }, [isPlanRequest, request, t]);

  const planMarkdown = useMemo(() => {
    if (!request) {
      return undefined;
    }
    const planFromMetadata =
      typeof request.metadata?.planText === "string" ? request.metadata.planText : undefined;
    if (planFromMetadata) {
      return planFromMetadata;
    }
    const candidate = request.input?.["plan"];
    if (typeof candidate === "string") {
      return candidate;
    }
    return undefined;
  }, [request]);

  const permissionMutation = useMutation({
    mutationFn: async (input: {
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
    }) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return client.respondToPermissionAndWait(
        input.agentId,
        input.requestId,
        input.response,
        15000,
      );
    },
  });
  const {
    reset: resetPermissionMutation,
    mutateAsync: respondToPermission,
    isPending: isResponding,
  } = permissionMutation;

  const [respondingActionId, setRespondingActionId] = useState<string | null>(null);

  useEffect(() => {
    resetPermissionMutation();
    setRespondingActionId(null);
  }, [permission.request.id, resetPermissionMutation]);
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      respondToPermission({
        agentId: permission.agentId,
        requestId: permission.request.id,
        response,
      }).catch((error) => {
        console.error("[PermissionRequestCard] Failed to respond to permission:", error);
      });
    },
    [permission.agentId, permission.request.id, respondToPermission],
  );
  const handleActionPress = useCallback(
    (action: AgentPermissionAction) => {
      setRespondingActionId(action.id);
      if (action.behavior === "allow") {
        handleResponse({
          behavior: "allow",
          selectedActionId: action.id,
        });
        return;
      }
      handleResponse({
        behavior: "deny",
        selectedActionId: action.id,
        message: "Denied by user",
      });
    },
    [handleResponse],
  );

  const optionsContainerStyle = useMemo(
    () => [
      permissionStyles.optionsContainer,
      !isMobile && permissionStyles.optionsContainerDesktop,
    ],
    [isMobile],
  );

  if (request.kind === "question") {
    return (
      <QuestionFormCard
        permission={permission}
        onRespond={handleResponse}
        isResponding={isResponding}
      />
    );
  }

  const footer = (
    <>
      <Text testID="permission-request-question" style={permissionStyles.question}>
        {t("agentStream.permission.question")}
      </Text>

      <View style={optionsContainerStyle}>
        {resolvedActions.map((action) => {
          const isPrimary = action.variant === "primary";
          const isRespondingAction = respondingActionId === action.id;
          const Icon = action.behavior === "allow" ? ThemedCheckIcon : ThemedXIcon;
          let testID: string;
          if (action.behavior === "deny") testID = "permission-request-deny";
          else if (action.id === "accept" || action.id === "implement")
            testID = "permission-request-accept";
          else testID = `permission-request-action-${action.id}`;

          return (
            <PermissionActionButton
              key={action.id}
              action={action}
              isRespondingAction={isRespondingAction}
              isResponding={isResponding}
              isPrimary={isPrimary}
              Icon={Icon}
              testID={testID}
              onPress={handleActionPress}
            />
          );
        })}
      </View>
    </>
  );

  if (isPlanRequest && planMarkdown) {
    return (
      <PlanCard
        title={title}
        description={description}
        text={planMarkdown}
        footer={footer}
        testID="permission-plan-card"
        disableOuterSpacing
      />
    );
  }

  return (
    <View style={permissionStyles.container}>
      <Text style={permissionStyles.title}>{title}</Text>

      {description ? <Text style={permissionStyles.description}>{description}</Text> : null}

      {planMarkdown ? (
        <PlanCard
          title={t("agentStream.permission.proposedPlan")}
          text={planMarkdown}
          testID="permission-plan-card"
          disableOuterSpacing
        />
      ) : null}

      {!isPlanRequest ? (
        <ToolCallDetailsContent detail={resolvedToolCallDetail} maxHeight={200} />
      ) : null}

      {footer}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  listContentContainer: {
    paddingVertical: 0,
    flexGrow: 1,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  forwardListContentContainer: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  list: {
    flex: 1,
  },
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
  },
  permissionsContainer: {
    gap: theme.spacing[2],
  },
  listHeaderContent: {
    gap: theme.spacing[3],
  },
  syncingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
  },
  syncingIndicatorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  invertedWrapper: {
    transform: [{ scaleY: -1 }],
    width: "100%",
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  scrollToBottomContainer: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scrollToBottomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  scrollToBottomIcon: {
    color: theme.colors.foreground,
  },
}));

const permissionStyles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
  },
  question: {
    fontSize: theme.fontSize.base,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionsContainerDesktop: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
    width: "100%",
  },
  optionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  optionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  optionButtonPressed: {
    opacity: 0.9,
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  optionTextPrimary: {
    color: theme.colors.foreground,
  },
}));

interface StreamItemWrapperProps {
  itemId: string;
  gapBelow: number;
  children: ReactNode;
}

function StreamItemWrapper({ gapBelow, children }: StreamItemWrapperProps) {
  const wrapperStyle = useMemo(
    () => [stylesheet.streamItemWrapper, { marginBottom: gapBelow }],
    [gapBelow],
  );
  return <View style={wrapperStyle}>{children}</View>;
}
