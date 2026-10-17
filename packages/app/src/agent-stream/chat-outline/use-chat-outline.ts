import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import { createOutlineNavigation } from "./navigation";
import type {
  ActivePromptSource,
  ChatOutlinePrompt,
  OutlineAccessibilityAction,
  ReadingPosition,
} from "./model";

const NO_STREAM_ITEMS: StreamItem[] = [];
const NO_PROMPTS: ChatOutlinePrompt[] = [];

export interface UseChatOutlineInput {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  enabled: boolean;
  /** The host serves `agent.timeline.list_prompts`. The rail draws that index and nothing else. */
  supportsPromptIndex: boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  onJumpError: () => void;
  mountedHistoryMessageIds?: ReadonlySet<string>;
  revealLoadedMessage?: (messageId: string) => boolean;
}

export interface ChatOutline {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  jumpToPrompt: (seq: number) => void;
  stepToPrompt: (action: OutlineAccessibilityAction) => void;
  cancelSelection: () => void;
  reportReadingPosition: (position: ReadingPosition | null) => void;
}

function latestPromptSeqIn(items: StreamItem[], timelineEpoch: string | null): number {
  let latest = -1;
  for (const item of items) {
    if (item.kind === "user_message" && item.timelineCursor?.epoch === timelineEpoch) {
      latest = Math.max(latest, item.timelineCursor.seq);
    }
  }
  return latest;
}

export function useChatOutline({
  agentId,
  serverId,
  timelineEpoch,
  tail: providedTail,
  head: providedHead,
  enabled,
  supportsPromptIndex,
  viewportRef,
  onJumpError,
  mountedHistoryMessageIds,
  revealLoadedMessage,
}: UseChatOutlineInput): ChatOutline {
  const [navigation] = useState(() =>
    createOutlineNavigation({
      listPrompts: (identity) =>
        getHostRuntimeStore()
          .getClient(identity.serverId)
          ?.listAgentTimelinePrompts(identity.agentId) ?? null,
      fetchTimeline: (identity, plan) =>
        getHostRuntimeStore().fetchAgentTimeline(identity.serverId, identity.agentId, plan),
    }),
  );
  // Only the live head changes per delta. Disabled outlines do no timeline scanning.
  const tail = enabled ? providedTail : NO_STREAM_ITEMS;
  const head = enabled ? (providedHead ?? NO_STREAM_ITEMS) : NO_STREAM_ITEMS;
  const tailPromptSeq = useMemo(
    () => latestPromptSeqIn(tail, timelineEpoch),
    [tail, timelineEpoch],
  );
  const latestPromptSeq = Math.max(tailPromptSeq, latestPromptSeqIn(head, timelineEpoch));
  useEffect(() => {
    navigation.update({
      agentId,
      serverId,
      timelineEpoch,
      enabled,
      supportsPromptIndex,
      viewportRef,
      onJumpError,
      mountedHistoryMessageIds,
      revealLoadedMessage,
      tail,
      head,
      latestPromptSeq,
    });
  }, [
    navigation,
    agentId,
    serverId,
    timelineEpoch,
    enabled,
    supportsPromptIndex,
    viewportRef,
    onJumpError,
    mountedHistoryMessageIds,
    revealLoadedMessage,
    tail,
    head,
    latestPromptSeq,
  ]);
  useEffect(() => () => navigation.dispose(), [navigation]);
  const prompts = useSyncExternalStore(navigation.subscribe, navigation.getPrompts);
  return {
    prompts: enabled ? prompts : NO_PROMPTS,
    activePrompt: navigation.activePrompt,
    jumpToPrompt: navigation.jumpToPrompt,
    stepToPrompt: navigation.stepToPrompt,
    cancelSelection: navigation.cancelSelection,
    reportReadingPosition: navigation.reportReadingPosition,
  };
}
