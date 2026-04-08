import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, Text, Pressable, Platform, ActivityIndicator } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
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
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./use-bottom-anchor-controller";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { normalizeInlinePathTarget } from "@/utils/inline-path";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  getWorkingIndicatorDotStrength,
  WORKING_INDICATOR_CYCLE_MS,
  WORKING_INDICATOR_OFFSETS,
} from "@/utils/working-indicator";

const isUserMessageItem = (item?: StreamItem) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";
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
      onOpenWorkspaceFile,
    },
    ref,
  ) {
    const viewportRef = useRef<StreamViewportHandle | null>(null);
    const { theme } = useUnistyles();
    const router = useRouter();
    const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
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
    const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
    const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);

    // Get serverId (fallback to agent's serverId if not provided)
    const resolvedServerId = serverId ?? agent.serverId ?? "";

    const client = useSessionStore((state) => state.sessions[resolvedServerId]?.client ?? null);
    const streamHead = useSessionStore((state) =>
      state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId),
    );

    const workspaceRoot = agent.cwd?.trim() || "";
    const workspaceId = agent.projectPlacement?.checkout?.cwd?.trim() || workspaceRoot;
    const { requestDirectoryListing } = useFileExplorerActions({
      serverId: resolvedServerId,
      workspaceId,
      workspaceRoot,
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

          const route = prepareWorkspaceTab({
            serverId: resolvedServerId,
            workspaceId,
            target: { kind: "file", path: normalized.file },
          });
          router.navigate(route);
          return;
        }

        void requestDirectoryListing(normalized.directory, {
          recordHistory: false,
          setCurrentPath: false,
        });

        setExplorerTabForCheckout({
          serverId: resolvedServerId,
          cwd: agent.cwd,
          isGit: agent.projectPlacement?.checkout?.isGit ?? true,
          tab: "files",
        });
        openFileExplorer();
      },
      [
        agent.cwd,
        openFileExplorer,
        requestDirectoryListing,
        resolvedServerId,
        router,
        setExplorerTabForCheckout,
        openWorkspaceFile,
        workspaceId,
      ],
    );

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        tail: streamItems,
        head: streamHead ?? [],
        platform: Platform.OS === "web" ? "web" : "native",
        isMobileBreakpoint: isMobile,
      });
    }, [isMobile, streamHead, streamItems]);
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

    function scrollToBottom() {
      viewportRef.current?.scrollToBottom("jump-to-bottom");
    }

    const tightGap = theme.spacing[1]; // 4px
    const looseGap = theme.spacing[4]; // 16px

    const getGapBetween = useCallback(
      (item: StreamItem | null, belowItem: StreamItem | null) => {
        if (!item || !belowItem) {
          return 0;
        }

        if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
          return tightGap;
        }
        if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
          return tightGap;
        }
        if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
          return looseGap;
        }
        if ((item.kind === "user_message" || item.kind === "assistant_message") && isToolSequenceItem(belowItem)) {
          return tightGap;
        }
        if (item.kind === "todo_list" && isToolSequenceItem(belowItem)) {
          return tightGap;
        }
        if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
          return tightGap;
        }
        return looseGap;
      },
      [looseGap, tightGap],
    );

    const renderStreamItemContent = useCallback(
      (
        item: StreamItem,
        index: number,
        items: StreamItem[],
        seamAboveItem: StreamItem | null = null,
      ) => {
        const handleInlineDetailsExpandedChange = (expanded: boolean) => {
          if (!streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion()) {
            return;
          }
          setExpandedInlineToolCallIds((previous) => {
            const next = new Set(previous);
            if (expanded) {
              next.add(item.id);
            } else {
              next.delete(item.id);
            }
            return next;
          });
        };

        switch (item.kind) {
          case "user_message": {
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
                timestamp={item.timestamp.getTime()}
                isFirstInGroup={isFirstInGroup}
                isLastInGroup={isLastInGroup}
              />
            );
          }

          case "assistant_message":
            return (
              <AssistantMessage
                message={item.text}
                timestamp={item.timestamp.getTime()}
                onInlinePathPress={handleInlinePathPress}
                workspaceRoot={workspaceRoot}
              />
            );
          case "thought": {
            const nextItem = getStreamNeighborItem({
              strategy: streamRenderStrategy,
              items,
              index,
              relation: "below",
            });
            const isLastInSequence = nextItem?.kind !== "tool_call" && nextItem?.kind !== "thought";
            return (
              <ToolCall
                toolName="thinking"
                args={item.text}
                status={item.status === "ready" ? "completed" : "executing"}
                isLastInSequence={isLastInSequence}
                onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
              />
            );
          }

          case "tool_call": {
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
                  <SpeakMessage
                    message={data.detail.input}
                    timestamp={item.timestamp.getTime()}
                  />
                );
              }

              return (
                <ToolCall
                  toolName={data.name}
                  error={data.error}
                  status={data.status}
                  detail={data.detail}
                  cwd={agent.cwd}
                  metadata={data.metadata}
                  isLastInSequence={isLastInSequence}
                  onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
                />
              );
            }

            const data = payload.data;
            return (
              <ToolCall
                toolName={data.toolName}
                args={data.arguments}
                result={data.result}
                status={data.status}
                isLastInSequence={isLastInSequence}
                onInlineDetailsExpandedChange={handleInlineDetailsExpandedChange}
              />
            );
          }

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
      [handleInlinePathPress, agent.cwd, streamRenderStrategy],
    );

    const renderStreamItem = useCallback(
      (
        item: StreamItem,
        index: number,
        items: StreamItem[],
        seamAboveItem: StreamItem | null = null,
      ) => {
        const content = renderStreamItemContent(item, index, items, seamAboveItem);
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
        const getTurnContent = () =>
          collectAssistantTurnContentForStreamRenderStrategy({
            strategy: streamRenderStrategy,
            items,
            startIndex: index,
          });

        return (
          <View style={[stylesheet.streamItemWrapper, { marginBottom: gapBelow }]}>
            {content}
            {isEndOfAssistantTurn ? <TurnCopyButton getContent={getTurnContent} /> : null}
          </View>
        );
      },
      [getGapBetween, renderStreamItemContent, agent.status, streamRenderStrategy],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const showWorkingIndicator = agent.status === "running";
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      const pendingPermissionsNode =
        pendingPermissionItems.length > 0 ? (
          <View style={stylesheet.permissionsContainer}>
            {pendingPermissionItems.map((permission) => (
              <PermissionRequestCard key={permission.key} permission={permission} client={client} />
            ))}
          </View>
        ) : null;
      const workingIndicatorNode = showWorkingIndicator ? (
        <View style={stylesheet.bottomBarWrapper}>
          <WorkingIndicator />
        </View>
      ) : null;

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
    }, [baseRenderModel, client, getGapBetween, pendingPermissionItems, showWorkingIndicator]);

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
        <View style={[stylesheet.emptyState, stylesheet.contentWrapper]}>
          <Text style={stylesheet.emptyStateText}>Start chatting with this agent...</Text>
        </View>
      );
    }, [renderModel]);

    const historyItems = renderModel.history;
    const liveHeadItems = renderModel.segments.liveHead;
    const { boundary, auxiliary } = renderModel;
    const lastHistoryItem = historyItems.at(-1) ?? null;

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
        return renderStreamItem(item, historyIndex, historyItems);
      },
      [historyIndexById, historyItems, renderStreamItem],
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
        renderStreamItem(item, index, items, index === 0 ? lastHistoryItem : null),
      [lastHistoryItem, renderStreamItem],
    );
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      if (!auxiliary.pendingPermissions && !auxiliary.workingIndicator) {
        return null;
      }
      return (
        <View style={stylesheet.contentWrapper}>
          <View
            style={[
              stylesheet.listHeaderContent,
              boundary.hasLiveHead ? { paddingTop: tightGap } : null,
            ]}
          >
            {auxiliary.pendingPermissions}
            {auxiliary.workingIndicator}
          </View>
        </View>
      );
    }, [auxiliary.pendingPermissions, auxiliary.workingIndicator, boundary.hasLiveHead, tightGap]);

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

function WorkingIndicator() {
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

  return (
    <View style={stylesheet.workingIndicatorBubble}>
      <View style={stylesheet.workingDotsRow}>
        <Animated.View style={[stylesheet.workingDot, dotOneStyle]} />
        <Animated.View style={[stylesheet.workingDot, dotTwoStyle]} />
        <Animated.View style={[stylesheet.workingDot, dotThreeStyle]} />
      </View>
    </View>
  );
}

// Permission Request Card Component
function PermissionRequestCard({
  permission,
  client,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
}) {
  const { theme } = useUnistyles();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest ? "Plan" : (request.title ?? request.name ?? "Permission Required");
  const description = request.description ?? "";
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
      <Text
        testID="permission-request-question"
        style={[permissionStyles.question, { color: theme.colors.foregroundMuted }]}
      >
        How would you like to proceed?
      </Text>

      <View
        style={[
          permissionStyles.optionsContainer,
          !isMobile && permissionStyles.optionsContainerDesktop,
        ]}
      >
        {resolvedActions.map((action) => {
          const isDanger = action.variant === "danger" || action.behavior === "deny";
          const isPrimary = action.variant === "primary";
          const isRespondingAction = respondingActionId === action.id;
          const textColor = isPrimary ? theme.colors.foreground : theme.colors.foregroundMuted;
          const iconColor = textColor;
          const Icon = action.behavior === "allow" ? Check : X;
          const testID =
            action.behavior === "deny"
              ? "permission-request-deny"
              : action.id === "accept" || action.id === "implement"
                ? "permission-request-accept"
                : `permission-request-action-${action.id}`;

          return (
            <Pressable
              key={action.id}
              testID={testID}
              style={({ pressed, hovered = false }) => [
                permissionStyles.optionButton,
                {
                  backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
                  borderColor: isDanger ? theme.colors.borderAccent : theme.colors.borderAccent,
                },
                pressed ? permissionStyles.optionButtonPressed : null,
              ]}
              onPress={() => handleActionPress(action)}
              disabled={isResponding}
            >
              {isRespondingAction ? (
                <ActivityIndicator size="small" color={textColor} />
              ) : (
                <View style={permissionStyles.optionContent}>
                  <Icon size={14} color={iconColor} />
                  <Text style={[permissionStyles.optionText, { color: textColor }]}>
                    {action.label}
                  </Text>
                </View>
              )}
            </Pressable>
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
        disableOuterSpacing
      />
    );
  }

  return (
    <View
      style={[
        permissionStyles.container,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text style={[permissionStyles.title, { color: theme.colors.foreground }]}>{title}</Text>

      {description ? (
        <Text style={[permissionStyles.description, { color: theme.colors.foregroundMuted }]}>
          {description}
        </Text>
      ) : null}

      {planMarkdown ? <PlanCard title="Proposed plan" text={planMarkdown} disableOuterSpacing /> : null}

      {!isPlanRequest ? (
        <ToolCallDetailsContent
          detail={
            request.detail ?? {
              type: "unknown",
              input: request.input ?? null,
              output: null,
            }
          }
          maxHeight={200}
        />
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
    paddingLeft: 3,
    paddingRight: 3,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
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
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
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
  },
}));
