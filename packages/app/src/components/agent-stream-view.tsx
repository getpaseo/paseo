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
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import Animated, {
  FadeIn,
  FadeOut,
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
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
  TurnCopyButton,
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
  collectAssistantTurnContentForStreamRenderStrategy,
  getStreamNeighborItem,
  resolveStreamRenderStrategy,
  type AgentStreamRenderModel,
  type StreamSegmentRenderers,
  type StreamViewportHandle,
} from "./agent-stream-render-strategy";
import {
  getAssistantBlockSpacing,
  isSameAssistantBlockGroup,
  resolveInlineWorkingIndicatorItemId,
} from "./agent-stream-view-data";
import {
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./use-bottom-anchor-controller";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { normalizeInlinePathTarget } from "@/utils/inline-path";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  getWorkingIndicatorDotStrength,
  WORKING_INDICATOR_CYCLE_MS,
  WORKING_INDICATOR_OFFSETS,
} from "@/utils/working-indicator";
import { isWeb } from "@/constants/platform";
import { SPACING, type Theme } from "@/styles/theme";

const isUserMessageItem = (item?: StreamItem) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";

interface StreamItemBoundarySeams {
  aboveItem?: StreamItem | null;
  belowItem?: StreamItem | null;
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
  onOpenWorkspaceFile?: (input: { filePath: string }) => void;
}

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
    const router = useRouter();
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
      (target: InlinePathTarget) => {
        if (!target.path) {
          return;
        }

        const normalized = normalizeInlinePathTarget(target.path, agent.cwd);
        if (!normalized) {
          return;
        }

        if (normalized.file) {
          if (onOpenWorkspaceFile) {
            openWorkspaceFile({ filePath: normalized.file });
            return;
          }

          if (workspaceId) {
            const route = prepareWorkspaceTab({
              serverId: resolvedServerId,
              workspaceId,
              target: { kind: "file", path: normalized.file },
            });
            router.navigate(route);
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
        router,
        setExplorerTabForCheckout,
        openWorkspaceFile,
        workspaceId,
      ],
    );

    const handleToolCallOpenFile = useCallback(
      (filePath: string) => {
        handleInlinePathPress({ raw: filePath, path: filePath });
      },
      [handleInlinePathPress],
    );

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        tail: streamItems,
        head: streamHead ?? [],
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
      });
    }, [isMobile, streamHead, streamItems]);
    const inlineWorkingIndicatorItemId = useMemo(
      () =>
        resolveInlineWorkingIndicatorItemId(
          agent.status,
          baseRenderModel.segments.liveHead,
          streamRenderStrategy,
        ),
      [agent.status, baseRenderModel.segments.liveHead, streamRenderStrategy],
    );
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

    const tightGap = SPACING[1];
    const assistantBlockGap = SPACING[3];
    const looseGap = SPACING[4];

    const getGapBetween = useCallback(
      (item: StreamItem | null, belowItem: StreamItem | null) => {
        if (!item || !belowItem) {
          return 0;
        }

        if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
          return tightGap;
        }
        if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
          return 0;
        }
        if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
          return looseGap;
        }
        if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
          return tightGap;
        }
        if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
          return looseGap;
        }
        if (isSameAssistantBlockGroup({ item, other: belowItem })) {
          return assistantBlockGap;
        }
        return looseGap;
      },
      [assistantBlockGap, looseGap, tightGap],
    );

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
            spacing={spacing}
          />
        );
      },
      [handleInlinePathPress, streamRenderStrategy, workspaceRoot, serverId, client],
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
            return <CompactionMarker status={item.status} preTokens={item.preTokens} />;

          default:
            return null;
        }
      },
      [renderUserMessageItem, renderAssistantMessageItem, renderThoughtItem, renderToolCallItem],
    );

    const renderStreamItem = useCallback(
      (
        item: StreamItem,
        index: number,
        items: StreamItem[],
        seams: StreamItemBoundarySeams = {},
      ) => {
        const content = renderStreamItemContent(item, index, items, seams);
        if (!content) {
          return null;
        }

        const nextItem = getStreamNeighborItem({
          strategy: streamRenderStrategy,
          items,
          index,
          relation: "below",
        });
        const gapBelow = getGapBetween(item, nextItem ?? null);
        const isEndOfAssistantTurn =
          item.kind === "assistant_message" &&
          (nextItem?.kind === "user_message" ||
            (nextItem === undefined && agent.status !== "running"));
        const isRunningAssistantTurnFooter =
          item.kind === "assistant_message" && item.id === inlineWorkingIndicatorItemId;
        let footer: ReactNode = null;
        if (isRunningAssistantTurnFooter) {
          footer = <InlineWorkingIndicatorSlot />;
        } else if (isEndOfAssistantTurn) {
          footer = (
            <TurnCopyButtonSlot strategy={streamRenderStrategy} items={items} startIndex={index} />
          );
        }

        return (
          <StreamItemWrapper gapBelow={gapBelow}>
            {content}
            {footer}
          </StreamItemWrapper>
        );
      },
      [
        getGapBetween,
        renderStreamItemContent,
        agent.status,
        streamRenderStrategy,
        inlineWorkingIndicatorItemId,
      ],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const showAuxiliaryWorkingIndicator =
      agent.status === "running" && inlineWorkingIndicatorItemId === null;
    const pendingPermissionsNode = useMemo(
      () =>
        pendingPermissionItems.length > 0 ? (
          <View style={stylesheet.permissionsContainer}>
            {pendingPermissionItems.map((permission) => (
              <PermissionRequestCard key={permission.key} permission={permission} client={client} />
            ))}
          </View>
        ) : null,
      [client, pendingPermissionItems],
    );
    const workingIndicatorNode = useMemo(
      () =>
        showAuxiliaryWorkingIndicator ? (
          <View style={stylesheet.bottomBarWrapper} testID="stream-working-indicator-auxiliary">
            <WorkingIndicator />
          </View>
        ) : null,
      [showAuxiliaryWorkingIndicator],
    );
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      return {
        ...baseRenderModel,
        boundary: {
          ...baseRenderModel.boundary,
          historyToHeadGap: getGapBetween(
            baseRenderModel.history.at(-1) ?? null,
            baseRenderModel.segments.liveHead[0] ?? null,
          ),
        },
        auxiliary: {
          pendingPermissions: pendingPermissionsNode,
          workingIndicator: workingIndicatorNode,
        },
      };
    }, [baseRenderModel, getGapBetween, pendingPermissionsNode, workingIndicatorNode]);

    const emptyStateStyle = useMemo(() => [stylesheet.emptyState, stylesheet.contentWrapper], []);
    const listEmptyComponent = useMemo(() => {
      if (
        renderModel.boundary.hasVirtualizedHistory ||
        renderModel.boundary.hasMountedHistory ||
        renderModel.boundary.hasLiveHead ||
        renderModel.auxiliary.pendingPermissions ||
        renderModel.auxiliary.workingIndicator
      ) {
        return null;
      }

      return (
        <View style={emptyStateStyle}>
          <Text style={stylesheet.emptyStateText}>Start chatting with this agent...</Text>
        </View>
      );
    }, [renderModel, emptyStateStyle]);

    const historyItems = renderModel.history;
    const _liveHeadItems = renderModel.segments.liveHead;
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
      (item: StreamItem) => {
        const historyIndex = historyIndexById.get(item.id);
        if (historyIndex === undefined) {
          return null;
        }
        const seamBelowItem = item.id === lastHistoryItem?.id ? firstLiveHeadItem : null;
        return renderStreamItem(item, historyIndex, historyItems, {
          belowItem: seamBelowItem,
        });
      },
      [firstLiveHeadItem, historyIndexById, historyItems, lastHistoryItem?.id, renderStreamItem],
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
        renderStreamItem(item, index, items, {
          aboveItem: index === 0 ? lastHistoryItem : null,
        }),
      [lastHistoryItem, renderStreamItem],
    );
    const liveAuxiliaryHeaderStyle = useMemo(() => {
      let headerPadding: { paddingBottom: number } | { paddingTop: number } | null;
      if (!boundary.hasLiveHead) headerPadding = null;
      else if (streamRenderStrategy.getFlatListInverted())
        headerPadding = { paddingBottom: looseGap };
      else headerPadding = { paddingTop: looseGap };
      return [stylesheet.listHeaderContent, headerPadding];
    }, [boundary.hasLiveHead, streamRenderStrategy, looseGap]);
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      if (!auxiliary.pendingPermissions && !auxiliary.workingIndicator) {
        return null;
      }
      return (
        <View style={stylesheet.contentWrapper}>
          <View style={liveAuxiliaryHeaderStyle}>
            {auxiliary.pendingPermissions}
            {auxiliary.workingIndicator}
          </View>
        </View>
      );
    }, [auxiliary.pendingPermissions, auxiliary.workingIndicator, liveAuxiliaryHeaderStyle]);

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

function WorkingIndicator({ variant = "auxiliary" }: { variant?: "auxiliary" | "inline" }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, {
        duration: WORKING_INDICATOR_CYCLE_MS,
        easing: Easing.linear,
      }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(progress);
      progress.value = 0;
    };
  }, [progress]);

  const translateDistance = -2;
  const dotOneStyle = useAnimatedStyle(() => {
    const strength = getWorkingIndicatorDotStrength(progress.value, WORKING_INDICATOR_OFFSETS[0]);
    return {
      opacity: 0.3 + strength * 0.7,
      transform: [{ translateY: strength * translateDistance }],
    };
  });

  const dotTwoStyle = useAnimatedStyle(() => {
    const strength = getWorkingIndicatorDotStrength(progress.value, WORKING_INDICATOR_OFFSETS[1]);
    return {
      opacity: 0.3 + strength * 0.7,
      transform: [{ translateY: strength * translateDistance }],
    };
  });

  const dotThreeStyle = useAnimatedStyle(() => {
    const strength = getWorkingIndicatorDotStrength(progress.value, WORKING_INDICATOR_OFFSETS[2]);
    return {
      opacity: 0.3 + strength * 0.7,
      transform: [{ translateY: strength * translateDistance }],
    };
  });

  const dotOneCombinedStyle = useMemo(() => [stylesheet.workingDot, dotOneStyle], [dotOneStyle]);
  const dotTwoCombinedStyle = useMemo(() => [stylesheet.workingDot, dotTwoStyle], [dotTwoStyle]);
  const dotThreeCombinedStyle = useMemo(
    () => [stylesheet.workingDot, dotThreeStyle],
    [dotThreeStyle],
  );

  const containerStyle =
    variant === "inline"
      ? stylesheet.inlineWorkingIndicatorFrame
      : stylesheet.workingIndicatorBubble;

  return (
    <View style={containerStyle}>
      <View style={stylesheet.workingDotsRow}>
        <Animated.View style={dotOneCombinedStyle} />
        <Animated.View style={dotTwoCombinedStyle} />
        <Animated.View style={dotThreeCombinedStyle} />
      </View>
    </View>
  );
}

function InlineWorkingIndicatorSlot() {
  return (
    <View style={stylesheet.inlineTurnFooter} testID="turn-working-indicator">
      <WorkingIndicator variant="inline" />
    </View>
  );
}

// Permission Request Card Component
type TurnContentStrategy = Parameters<
  typeof collectAssistantTurnContentForStreamRenderStrategy
>[0]["strategy"];

interface TurnCopyButtonSlotProps {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  startIndex: number;
}

function TurnCopyButtonSlot({ strategy, items, startIndex }: TurnCopyButtonSlotProps) {
  const getContent = useCallback(
    () =>
      collectAssistantTurnContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  return <TurnCopyButton getContent={getContent} />;
}

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
  bottomBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    marginTop: theme.spacing[4],
    paddingLeft: 3,
    paddingRight: 3,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
  },
  inlineTurnFooter: {
    alignSelf: "flex-start",
    marginTop: theme.spacing[2],
    padding: theme.spacing[2],
    paddingTop: 0,
  },
  inlineWorkingIndicatorFrame: {
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  workingIndicatorBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: 0,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: 0,
    alignSelf: "flex-start",
  },
  workingDotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foregroundMuted,
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
