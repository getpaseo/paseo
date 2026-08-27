import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  visibleItemIds?: ReadonlySet<string>;
  revealLoadedItem?: (itemId: string) => boolean;
}

export interface ChatOutline {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  jumpToPrompt: (seq: number) => void;
  reportReadingPosition: (rowId: string | null) => void;
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
  visibleItemIds,
  revealLoadedItem,
}: UseChatOutlineInput): ChatOutline {
  const [index, setIndex] = useState<AgentTimelinePromptIndexPayload | null>(null);
  const [pendingJump, setPendingJump] = useState<PendingPromptJump | null>(null);
  const [activePrompt] = useState(createActivePromptPublisher);
  const readingRowIdRef = useRef<string | null>(null);
  const nextJumpRequestIdRef = useRef(0);
  const nextIndexRequestIdRef = useRef(0);
  const loadedItems = useMemo(() => [...tail, ...(head ?? NO_STREAM_ITEMS)], [head, tail]);
  const prompts = enabled ? (index?.prompts ?? NO_PROMPTS) : NO_PROMPTS;

  useEffect(() => {
    if (!isWeb || !enabled) {
      setIndex(null);
      return;
    }
    setIndex(null);
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
    const unsubscribe = client.on("agent_stream", (message) => {
      if (
        message.type === "agent_stream" &&
        message.payload.agentId === agentId &&
        message.payload.event.type === "timeline" &&
        message.payload.event.item.type === "user_message"
      ) {
        refresh();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [agentId, enabled, serverId, timelineEpoch]);

  // The transcript names the row it is showing; the outline turns that into a prompt using the
  // complete index, so unloaded rows never have to exist in the DOM to be marked.
  const publishActivePrompt = useStableEvent(() => {
    const rowId = readingRowIdRef.current;
    const anchorSeq =
      rowId === null
        ? null
        : (loadedItems.find((item) => item.id === rowId)?.timelineCursor?.seq ?? null);
    activePrompt.publish(resolveActivePromptSeq(prompts, anchorSeq));
  });

  const reportReadingPosition = useStableEvent((rowId: string | null) => {
    readingRowIdRef.current = rowId;
    publishActivePrompt();
  });

  useEffect(() => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
    readingRowIdRef.current = null;
    activePrompt.publish(null);
  }, [activePrompt, agentId, timelineEpoch]);

  // The transcript reports its reading position long before the index arrives, and a reader
  // who never scrolls would otherwise sit on an unmarked rail.
  useEffect(() => {
    publishActivePrompt();
  }, [loadedItems, prompts, publishActivePrompt]);

  useEffect(() => {
    if (pendingJump === null) return;
    const target = loadedItems.find((item) => item.timelineCursor?.seq === pendingJump.seq);
    if (target) {
      if (pendingJump.hasScrolled) return;
      if (visibleItemIds?.has(target.id) === false) {
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
  }, [loadedItems, pendingJump, revealLoadedItem, viewportRef, visibleItemIds]);

  const jumpToPrompt = useCallback(
    (seq: number) => {
      nextJumpRequestIdRef.current += 1;
      setPendingJump(null);
      const loaded = loadedItems.find((item) => item.timelineCursor?.seq === seq);
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
    },
    [agentId, index, loadedItems, onJumpError, revealLoadedItem, serverId, viewportRef],
  );

  return { prompts, activePrompt, jumpToPrompt, reportReadingPosition };
}
