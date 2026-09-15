import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import {
  createActivePromptPublisher,
  resolveActivePromptSeq,
  shouldAcceptPromptIndexEpoch,
  type ActivePromptSource,
  type ChatOutlinePrompt,
} from "./model";

const NO_PROMPTS: ChatOutlinePrompt[] = [];
const NO_STREAM_ITEMS: StreamItem[] = [];

interface PendingPromptJump {
  requestId: number;
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

export interface UseChatOutlineInput {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  enabled: boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  onJumpError: () => void;
  // Ids of the history rows the viewport has mounted. Live head rows are always mounted.
  mountedHistoryItemIds?: ReadonlySet<string>;
  revealLoadedItem?: (itemId: string) => boolean;
}

export interface ChatOutline {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  jumpToPrompt: (seq: number) => void;
  reportReadingPosition: (seq: number | null) => void;
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

function findLoadedItem(
  tail: StreamItem[],
  head: StreamItem[],
  predicate: (item: StreamItem) => boolean,
): StreamItem | undefined {
  return tail.find(predicate) ?? head.find(predicate);
}

export function useChatOutline({
  agentId,
  serverId,
  timelineEpoch,
  tail,
  head,
  enabled,
  viewportRef,
  onJumpError,
  mountedHistoryItemIds,
  revealLoadedItem,
}: UseChatOutlineInput): ChatOutline {
  const [index, setIndex] = useState<AgentTimelinePromptIndexPayload | null>(null);
  const [pendingJump, setPendingJump] = useState<PendingPromptJump | null>(null);
  const [activePrompt] = useState(createActivePromptPublisher);
  const readingSeqRef = useRef<number | null>(null);
  const nextJumpRequestIdRef = useRef(0);
  const nextIndexRequestIdRef = useRef(0);
  // A disabled outline (every native viewport) must not pay for the timeline per delta.
  const loadedTail = enabled ? tail : NO_STREAM_ITEMS;
  const loadedHead = enabled ? (head ?? NO_STREAM_ITEMS) : NO_STREAM_ITEMS;
  const prompts = enabled ? (index?.prompts ?? NO_PROMPTS) : NO_PROMPTS;

  // The viewed timeline already owns live delivery and reconnect catch-up. Its complete
  // loaded items (including rows outside the mounted window) invalidate the prompt index.
  // Only the head changes per streamed delta, so the tail's contribution is memoized.
  const tailPromptSeq = useMemo(
    () => latestPromptSeqIn(loadedTail, timelineEpoch),
    [loadedTail, timelineEpoch],
  );
  const latestPromptSeq = Math.max(tailPromptSeq, latestPromptSeqIn(loadedHead, timelineEpoch));

  useEffect(() => setIndex(null), [agentId, enabled, serverId, timelineEpoch]);

  useEffect(() => {
    if (!isWeb || !enabled) {
      setIndex(null);
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) return;
    let active = true;
    const refresh = () => {
      const requestId = ++nextIndexRequestIdRef.current;
      void client
        .listAgentTimelinePrompts(agentId)
        .then((payload) => {
          if (
            active &&
            requestId === nextIndexRequestIdRef.current &&
            shouldAcceptPromptIndexEpoch(timelineEpoch, payload.epoch)
          ) {
            setIndex(payload);
          }
          return undefined;
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      active = false;
    };
  }, [agentId, enabled, serverId, timelineEpoch, latestPromptSeq]);

  // The transcript resolves display rows (including Markdown blocks and plugin cards) to
  // timeline positions. The outline uses the complete index, including unloaded prompts.
  const publishActivePrompt = useStableEvent(() => {
    activePrompt.publish(resolveActivePromptSeq(prompts, readingSeqRef.current));
  });

  const reportReadingPosition = useStableEvent((seq: number | null) => {
    readingSeqRef.current = seq;
    publishActivePrompt();
  });

  useEffect(() => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
    readingSeqRef.current = null;
    activePrompt.publish(null);
  }, [activePrompt, agentId, timelineEpoch]);

  // The transcript reports its reading position long before the index arrives, and a reader
  // who never scrolls would otherwise sit on an unmarked rail.
  useEffect(() => {
    publishActivePrompt();
  }, [prompts, publishActivePrompt]);

  useEffect(() => {
    if (pendingJump === null) return;
    const target = findLoadedItem(
      loadedTail,
      loadedHead,
      (item) => item.timelineCursor?.seq === pendingJump.seq,
    );
    if (target) {
      if (pendingJump.hasScrolled) return;
      const isMounted =
        mountedHistoryItemIds === undefined ||
        mountedHistoryItemIds.has(target.id) ||
        loadedHead.includes(target);
      if (!isMounted) {
        revealLoadedItem?.(target.id);
        return;
      }
      viewportRef.current?.scrollToMessage?.(target.id);
      setPendingJump((current) => {
        if (current?.requestId !== pendingJump.requestId) return current;
        return { ...current, hasScrolled: true };
      });
      return;
    }
    if (pendingJump.fetchSettled) setPendingJump(null);
  }, [loadedHead, loadedTail, mountedHistoryItemIds, pendingJump, revealLoadedItem, viewportRef]);

  const jumpToPrompt = useStableEvent((seq: number) => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
    const loaded = findLoadedItem(
      loadedTail,
      loadedHead,
      (item) => item.timelineCursor?.seq === seq,
    );
    if (loaded) {
      if (revealLoadedItem?.(loaded.id)) {
        const requestId = nextJumpRequestIdRef.current;
        setPendingJump({ requestId, seq, fetchSettled: true, hasScrolled: false });
        return;
      }
      viewportRef.current?.scrollToMessage?.(loaded.id);
      return;
    }
    if (!index) return;
    const requestId = nextJumpRequestIdRef.current;
    setPendingJump({ requestId, seq, fetchSettled: false, hasScrolled: false });
    void getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch: index.epoch, seq }))
      .catch((error: unknown) => {
        console.warn("Failed to load a Chat outline window", error);
        onJumpError();
      })
      .finally(() => {
        setPendingJump((current) => {
          if (current?.requestId !== requestId) return current;
          return { ...current, fetchSettled: true };
        });
      });
  });

  return { prompts, activePrompt, jumpToPrompt, reportReadingPosition };
}
