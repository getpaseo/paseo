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
import {
  View,
  Text,
  Pressable,
  Platform,
  ActivityIndicator,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useMutation } from "@tanstack/react-query";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Check, ChevronDown, X } from "lucide-react-native";
import { usePanelStore } from "@/stores/panel-store";
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
} from "./message";
import { PlanCard } from "./plan-card";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type {
  AgentPermissionAction,
  AgentPermissionResponse,
} from "@server/server/agent/agent-sdk-types";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useSessionStore } from "@/stores/session-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import type { ToastApi } from "@/components/toast-host";
import type { DaemonClient } from "@server/client/daemon-client";
import { ToolCallDetailsContent } from "./tool-call-details";
import { QuestionFormCard } from "./question-form-card";
import { ToolCallSheetProvider } from "./tool-call-sheet";
import {
  buildAgentStreamRenderModel,
  getStreamNeighborItem,
  resolveStreamRenderStrategy,
  type AgentStreamRenderModel,
  type StreamSegmentRenderers,
  type StreamViewportHandle,
} from "./agent-stream-render-strategy";
import { getAssistantBlockSpacing, getGapBetweenStreamItems } from "./agent-stream-view-data";
import {
  CompletedTurnFooterRow,
  resolveBottomTurnFooterHost,
  shouldRenderCompletedTurnFooter,
  TurnFooter,
  type TurnContentStrategy,
  type TurnFooterHost,
} from "./agent-stream-turn-footer";
import {
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./use-bottom-anchor-controller";
import { normalizeInlinePathTarget } from "@/utils/inline-path";
import type { OpenFileDisposition } from "@/utils/workspace-file-open";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

interface StreamItemBoundarySeams {
  aboveItem?: StreamItem | null;
  belowItem?: StreamItem | null;
  suppressTurnFooter?: boolean;
}

function renderLiveAuxiliaryNode(input: {
  pendingPermissions: ReactNode;
  turnFooter: ReactNode;
}): ReactNode {
  if (!input.pendingPermissions && !input.turnFooter) {
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
    </>
  );
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
  item: StreamItem;
  nextItem: StreamItem | undefined;
  items: StreamItem[];
  timing: AgentStreamRenderModel["turnTiming"]["byAssistantId"];
  index: number;
  agentStatus: string;
  suppressTurnFooter: boolean | undefined;
  strategy: TurnContentStrategy;
}): ReactNode {
  if (!input.content) {
    return null;
  }

  const showCompletedFooter = shouldRenderCompletedTurnFooter({
    item: input.item,
    belowItem: input.nextItem,
    agentStatus: input.agentStatus,
    suppressTurnFooter: input.suppressTurnFooter,
  });
  const gapBelow = showCompletedFooter
    ? 0
    : getGapBetweenStreamItems(input.item, input.nextItem ?? null);

  return (
    <>
      <StreamItemWrapper gapBelow={gapBelow}>{input.content}</StreamItemWrapper>
      {showCompletedFooter ? (
        <CompletedTurnFooterRow
          strategy={input.strategy}
          items={input.items}
          timing={input.timing.get(input.item.id)}
          startIndex={input.index}
        />
      ) : null}
    </>
  );
}

function renderListEmptyComponent(input: {
  renderModel: AgentStreamRenderModel;
  emptyStateStyle: StyleProp<ViewStyle>;
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
      <Text style={stylesheet.emptyStateText}>Start chatting with this agent...</Text>
    </View>
  );
}

function renderHistoryStreamItem(input: {
  item: StreamItem;
  historyIndexById: Map<string, number>;
  historyItems: StreamItem[];
  lastHistoryItem: StreamItem | null;
  firstLiveHeadItem: StreamItem | null;
  bottomTurnFooterHost: TurnFooterHost | null;
  renderStreamItem: (
    item: StreamItem,
    index: number,
    items: StreamItem[],
    seams?: StreamItemBoundarySeams,
  ) => ReactNode;
}): ReactNode {
  const historyIndex = input.historyIndexById.get(input.item.id);
  if (historyIndex === undefined) {
    return null;
  }
  const seamBelowItem =
    input.item.id === input.lastHistoryItem?.id ? input.firstLiveHeadItem : null;
  return input.renderStreamItem(input.item, historyIndex, input.historyItems, {
    belowItem: seamBelowItem,
    suppressTurnFooter: input.item.id === input.bottomTurnFooterHost?.itemId,
  });
}

function renderLiveHeadStreamItem(input: {
  item: StreamItem;
  index: number;
  items: StreamItem[];
  lastHistoryItem: StreamItem | null;
  bottomTurnFooterHost: TurnFooterHost | null;
  renderStreamItem: (
    item: StreamItem,
    index: number,
    items: StreamItem[],
    seams?: StreamItemBoundarySeams,
  ) => ReactNode;
}): ReactNode {
  return input.renderStreamItem(input.item, input.index, input.items, {
    aboveItem: input.index === 0 ? input.lastHistoryItem : null,
    suppressTurnFooter: input.item.id === input.bottomTurnFooterHost?.itemId,
  });
}

export interface AgentStreamViewHandle {
  scrollToBottom(reason?: BottomAnchorLocalRequest["reason"]): void;
  prepareForViewportChange(): void;
}

export interface AgentStreamViewProps {
  agentId: string;
  serverId?: string;
  agent: AgentScreenAgent;
  streamItems: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  routeBottomAnchorRequest?: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady?: boolean;
  toast?: ToastApi | null;
  onOpenWorkspaceFile?: (input: { filePath: string; disposition: OpenFileDisposition }) => void;
}

const EMPTY_STREAM_HEAD: StreamItem[] = [];

const AgentStreamViewComponent = forwardRef<AgentStreamViewHandle, AgentStreamViewProps>(
  function AgentStreamView(
    {
      agentId,
      serverId,
      agent,
      streamItems,
      pendingPermissions,
      routeBottomAnchorRequest = null,
      isAuthoritativeHistoryReady = true,
      toast,
      onOpenWorkspaceFile,
    },
    ref,
  ) {
    const viewportRef = useRef<StreamViewportHandle | null>(null);
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
    const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
    const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);

    // Get serverId (fallback to agent's serverId if not provided)
    const resolvedServerId = serverId ?? agent.serverId ?? "";

    const client = useSessionStore((state) => state.sessions[resolvedServerId]?.client ?? null);
    const streamHead = useSessionStore((state) =>
      state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId),
    );

    const workspaceRoot = agent.cwd?.trim() || "";
    const workspaceId = resolveWorkspaceIdByExecutionDirectory({
      workspaces: useSessionStore.getState().sessions[resolvedServerId]?.workspaces?.values(),
      workspaceDirectory: workspaceRoot,
    });
    const { requestDirectoryListing } = useFileExplorerActions({
      serverId: resolvedServerId,
      workspaceId: workspaceId ?? undefined,
      workspaceRoot,
    });
    const { isLoadingOlder, hasOlder, loadOlder } = useLoadOlderAgentHistory({
      serverId: resolvedServerId,
      agentId,
      toast,
    });
    const openWorkspaceFile = useStableEvent(function openWorkspaceFile(input: {
      filePath: string;
      disposition: OpenFileDisposition;
    }) {
      onOpenWorkspaceFile?.(input);
    });
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
    }, [agentId]);

    const handleInlinePathPress = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        if (!target.path) {
          return;
        }

        const normalized = normalizeInlinePathTarget(target.path, agent.cwd);
        if (!normalized) {
          return;
        }

        if (normalized.file) {
          if (onOpenWorkspaceFile) {
            openWorkspaceFile({ filePath: normalized.file, disposition });
            return;
          }

          if (workspaceId) {
            navigateToPreparedWorkspaceTab({
              serverId: resolvedServerId,
              workspaceId,
              target: { kind: "file", path: normalized.file },
            });
          }
          return;
        }

        void requestDirectoryListing(normalized.directory, {
          recordHistory: false,
          setCurrentPath: false,
        });

        const checkout = {
          serverId: resolvedServerId,
          cwd: agent.cwd,
          isGit: agent.projectPlacement?.checkout?.isGit ?? true,
        };
        setExplorerTabForCheckout({ ...checkout, tab: "files" });
        openFileExplorerForCheckout({
          isCompact: isMobile,
          checkout,
        });
      },
      [
        agent.cwd,
        agent.projectPlacement?.checkout?.isGit,
        isMobile,
        openFileExplorerForCheckout,
        onOpenWorkspaceFile,
        requestDirectoryListing,
        resolvedServerId,
        setExplorerTabForCheckout,
        openWorkspaceFile,
        workspaceId,
      ],
    );

    const handleToolCallOpenFile = useCallback(
      (filePath: string) => {
        handleInlinePathPress({ raw: filePath, path: filePath }, "main");
      },
      [handleInlinePathPress],
    );

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        agentStatus: agent.status,
        tail: streamItems,
        head: streamHead ?? EMPTY_STREAM_HEAD,
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
      });
    }, [agent.status, isMobile, streamHead, streamItems]);
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
      viewportRef.current?.scrollToBottom("jump-to-bottom");
    }, []);

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

    const renderUserMessageItem = useCallback(
      (
        item: Extract<StreamItem, { kind: "user_message" }>,
        index: number,
        items: StreamItem[],
        seamAboveItem: StreamItem | null,
      ) => {
        const aboveItem =
          getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "above",
          }) ??
          seamAboveItem ??
          undefined;
        const belowItem = getStreamNeighborItem({
          strategy: streamRenderStrategy,
          items,
          index,
          relation: "below",
        });
        const isFirstInGroup = aboveItem?.kind !== "user_message";
        const isLastInGroup = belowItem?.kind !== "user_message";
        return (
          <UserMessage
            message={item.text}
            images={item.images}
            attachments={item.attachments}
            timestamp={item.timestamp.getTime()}
            isFirstInGroup={isFirstInGroup}
            isLastInGroup={isLastInGroup}
          />
        );
      },
      [streamRenderStrategy],
    );

    const renderAssistantMessageItem = useCallback(
      (
        item: Extract<StreamItem, { kind: "assistant_message" }>,
        index: number,
        items: StreamItem[],
        seams: StreamItemBoundarySeams,
      ) => {
        const aboveItem =
          getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "above",
          }) ??
          seams.aboveItem ??
          undefined;
        const belowItem =
          getStreamNeighborItem({
            strategy: streamRenderStrategy,
            items,
            index,
            relation: "below",
          }) ??
          seams.belowItem ??
          undefined;
        const spacing = getAssistantBlockSpacing({
          item,
          aboveItem,
          belowItem,
        });
        return (
          <AssistantMessage
            message={item.text}
            timestamp={item.timestamp.getTime()}
            onInlinePathPress={handleInlinePathPress}
            workspaceRoot={workspaceRoot}
            serverId={serverId}
            client={client}
            toast={toast}
            spacing={spacing}
          />
        );
      },
      [handleInlinePathPress, streamRenderStrategy, workspaceRoot, serverId, client, toast],
    );

    const renderThoughtItem = useCallback(
      (item: Extract<StreamItem, { kind: "thought" }>, index: number, items: StreamItem[]) => {
        const nextItem = getStreamNeighborItem({
          strategy: streamRenderStrategy,
          items,
          index,
          relation: "below",
        });
        const isLastInSequence = nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName="thinking"
            args={item.text}
            status={item.status === "ready" ? "completed" : "executing"}
            isLastInSequence={isLastInSequence}
          />
        );
      },
      [streamRenderStrategy, setInlineDetailsExpanded],
    );

    const renderToolCallItem = useCallback(
      (item: Extract<StreamItem, { kind: "tool_call" }>, index: number, items: StreamItem[]) => {
        const { payload } = item;
        const nextItem = getStreamNeighborItem({
          strategy: streamRenderStrategy,
          items,
          index,
          relation: "below",
        });
        const isLastInSequence = nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";

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
              cwd={agent.cwd}
              metadata={data.metadata}
              isLastInSequence={isLastInSequence}
              onOpenFilePath={handleToolCallOpenFile}
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
          />
        );
      },
      [agent.cwd, streamRenderStrategy, setInlineDetailsExpanded, handleToolCallOpenFile],
    );

    const renderStreamItemContent = useCallback(
      (
        item: StreamItem,
        index: number,
        items: StreamItem[],
        seams: StreamItemBoundarySeams = {},
      ) => {
        switch (item.kind) {
          case "user_message":
            return renderUserMessageItem(item, index, items, seams.aboveItem ?? null);

          case "assistant_message":
            return renderAssistantMessageItem(item, index, items, seams);

          case "thought":
            return renderThoughtItem(item, index, items);

          case "tool_call":
            return renderToolCallItem(item, index, items);

          case "activity_log":
            return (
              <ActivityLog
                type={item.activityType}
                message={item.message}
                timestamp={item.timestamp.getTime()}
                metadata={item.metadata}
              />
            );

          case "todo_list":
            return <TodoListCard items={item.items} />;

          case "compaction":
            return (
              <CompactionMarker
                status={item.status}
                trigger={item.trigger}
                preTokens={item.preTokens}
              />
            );

          default:
            return null;
        }
      },
      [renderUserMessageItem, renderAssistantMessageItem, renderThoughtItem, renderToolCallItem],
    );

    const bottomTurnFooterHost = useMemo(() => {
      return resolveBottomTurnFooterHost({
        agentStatus: agent.status,
        history: baseRenderModel.history,
        liveHead: baseRenderModel.segments.liveHead,
        isInverted: streamRenderStrategy.getFlatListInverted(),
        timingByAssistantId: baseRenderModel.turnTiming.byAssistantId,
      });
    }, [
      agent.status,
      baseRenderModel.history,
      baseRenderModel.segments.liveHead,
      baseRenderModel.turnTiming.byAssistantId,
      streamRenderStrategy,
    ]);

    const renderStreamItem = useCallback(
      (
        item: StreamItem,
        index: number,
        items: StreamItem[],
        seams: StreamItemBoundarySeams = {},
      ) => {
        const content = renderStreamItemContent(item, index, items, seams);
        const nextItem = getStreamNeighborItem({
          strategy: streamRenderStrategy,
          items,
          index,
          relation: "below",
        });
        return renderStreamItemWithTurnFooter({
          content,
          item,
          nextItem,
          items,
          timing: baseRenderModel.turnTiming.byAssistantId,
          index,
          agentStatus: agent.status,
          suppressTurnFooter: seams.suppressTurnFooter,
          strategy: streamRenderStrategy,
        });
      },
      [
        agent.status,
        baseRenderModel.turnTiming.byAssistantId,
        renderStreamItemContent,
        streamRenderStrategy,
      ],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const showRunningTurnFooter = agent.status === "running";
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
        showRunningTurnFooter || bottomTurnFooterHost ? (
          <TurnFooter
            isRunning={showRunningTurnFooter}
            inFlightTurnStartedAt={baseRenderModel.turnTiming.runningStartedAt}
            host={bottomTurnFooterHost}
            strategy={streamRenderStrategy}
          />
        ) : null,
      [
        showRunningTurnFooter,
        baseRenderModel.turnTiming.runningStartedAt,
        bottomTurnFooterHost,
        streamRenderStrategy,
      ],
    );
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      return {
        ...baseRenderModel,
        boundary: {
          ...baseRenderModel.boundary,
          historyToHeadGap: getGapBetweenStreamItems(
            baseRenderModel.history.at(-1) ?? null,
            baseRenderModel.segments.liveHead[0] ?? null,
          ),
        },
        auxiliary: {
          pendingPermissions: pendingPermissionsNode,
          turnFooter: turnFooterNode,
        },
      };
    }, [baseRenderModel, pendingPermissionsNode, turnFooterNode]);

    const emptyStateStyle = useMemo(() => [stylesheet.emptyState, stylesheet.contentWrapper], []);
    const listEmptyComponent = useMemo(
      () => renderListEmptyComponent({ renderModel, emptyStateStyle }),
      [renderModel, emptyStateStyle],
    );

    const historyItems = renderModel.history;
    const { boundary, auxiliary } = renderModel;
    const lastHistoryItem = historyItems.at(-1) ?? null;
    const firstLiveHeadItem = renderModel.segments.liveHead[0] ?? null;

    const historyIndexById = useMemo(() => {
      const indexById = new Map<string, number>();
      historyItems.forEach((item, index) => {
        indexById.set(item.id, index);
      });
      return indexById;
    }, [historyItems]);

    const renderHistoryRow = useCallback(
      (item: StreamItem) =>
        renderHistoryStreamItem({
          item,
          historyIndexById,
          historyItems,
          lastHistoryItem,
          firstLiveHeadItem,
          bottomTurnFooterHost,
          renderStreamItem,
        }),
      [
        bottomTurnFooterHost,
        firstLiveHeadItem,
        historyIndexById,
        historyItems,
        lastHistoryItem,
        renderStreamItem,
      ],
    );

    const renderHistoryVirtualizedRow = useCallback<
      StreamSegmentRenderers["renderHistoryVirtualizedRow"]
    >((item) => renderHistoryRow(item), [renderHistoryRow]);
    const renderHistoryMountedRow = useCallback<StreamSegmentRenderers["renderHistoryMountedRow"]>(
      (item) => renderHistoryRow(item),
      [renderHistoryRow],
    );
    const renderLiveHeadRow = useCallback<StreamSegmentRenderers["renderLiveHeadRow"]>(
      (item, index, items) =>
        renderLiveHeadStreamItem({
          item,
          index,
          items,
          lastHistoryItem,
          bottomTurnFooterHost,
          renderStreamItem,
        }),
      [bottomTurnFooterHost, lastHistoryItem, renderStreamItem],
    );
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      return renderLiveAuxiliaryNode({
        pendingPermissions: auxiliary.pendingPermissions,
        turnFooter: auxiliary.turnFooter,
      });
    }, [auxiliary.pendingPermissions, auxiliary.turnFooter]);

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

    return (
      <ToolCallSheetProvider>
        <View style={stylesheet.container}>
          <MessageOuterSpacingProvider disableOuterSpacing>
            {streamRenderStrategy.render({
              agentId,
              segments: renderModel.segments,
              boundary,
              renderers,
              listEmptyComponent,
              viewportRef,
              routeBottomAnchorRequest,
              isAuthoritativeHistoryReady,
              onNearBottomChange: setIsNearBottom,
              onNearHistoryStart: loadOlder,
              isLoadingOlderHistory: isLoadingOlder,
              hasOlderHistory: hasOlder,
              scrollEnabled: streamScrollEnabled,
              listStyle: stylesheet.list,
              baseListContentContainerStyle: stylesheet.listContentContainer,
              forwardListContentContainerStyle: stylesheet.forwardListContentContainer,
            })}
          </MessageOuterSpacingProvider>
          {!isNearBottom && (
            <Animated.View
              style={stylesheet.scrollToBottomContainer}
              entering={scrollIndicatorFadeIn}
              exiting={scrollIndicatorFadeOut}
            >
              <View style={stylesheet.scrollToBottomInner}>
                <Pressable
                  style={stylesheet.scrollToBottomButton}
                  onPress={scrollToBottom}
                  accessibilityRole="button"
                  accessibilityLabel="Scroll to bottom"
                  testID="scroll-to-bottom-button"
                >
                  <ChevronDown size={24} color={stylesheet.scrollToBottomIcon.color} />
                </Pressable>
              </View>
            </Animated.View>
          )}
        </View>
      </ToolCallSheetProvider>
    );
  },
);

export const AgentStreamView = memo(AgentStreamViewComponent);
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

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
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
  const optionTextStyle = isPrimary ? optionTextPrimaryStyle : permissionStyles.optionText;
  const colorMapping = isPrimary ? primaryColorMapping : mutedColorMapping;
  return (
    <Pressable testID={testID} style={pressableStyle} onPress={handlePress} disabled={isResponding}>
      {isRespondingAction ? (
        <ThemedActivityIndicator size="small" uniProps={colorMapping} />
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
  const isMobile = useIsCompactFormFactor();

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest ? "Plan" : (request.title ?? request.name ?? "Permission Required");
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
        label: "Deny",
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      },
      {
        id: "accept",
        label: isPlanRequest ? "Implement" : "Accept",
        behavior: "allow",
        variant: "primary",
      },
    ];
  }, [isPlanRequest, request]);

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
        throw new Error("Daemon client unavailable");
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
        How would you like to proceed?
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
          title="Proposed plan"
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
      xs: theme.spacing[2],
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
    fontSize: theme.fontSize.sm,
  },
  invertedWrapper: {
    transform: [{ scaleY: -1 }],
    width: "100%",
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  scrollToBottomContainer: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  scrollToBottomInner: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
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
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
  },
  question: {
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionsContainerDesktop: {
    flexDirection: "row",
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  optionTextPrimary: {
    color: theme.colors.foreground,
  },
}));

const optionTextPrimaryStyle = [permissionStyles.optionText, permissionStyles.optionTextPrimary];

interface StreamItemWrapperProps {
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
