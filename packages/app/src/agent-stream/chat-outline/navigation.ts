import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import {
  createActivePromptPublisher,
  resolveActivePromptSeq,
  resolveOutlineAccessibilityIndex,
  shouldAcceptPromptIndexEpoch,
  type ChatOutlinePrompt,
  type OutlineAccessibilityAction,
  type ReadingPosition,
} from "./model";

export interface OutlineTimelineIdentity {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  enabled: boolean;
  supportsPromptIndex: boolean;
}

export interface OutlineNavigationInput extends OutlineTimelineIdentity {
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  latestPromptSeq: number;
  viewportRef: { current: StreamViewportHandle | null };
  onJumpError: () => void;
  mountedHistoryMessageIds?: ReadonlySet<string>;
  revealLoadedMessage?: (messageId: string) => boolean;
}

export interface OutlineNavigationPort {
  listPrompts: (
    identity: OutlineTimelineIdentity,
  ) => Promise<AgentTimelinePromptIndexPayload> | null;
  fetchTimeline: (
    identity: OutlineTimelineIdentity,
    plan: ReturnType<typeof planTimelinePromptJump>,
  ) => Promise<unknown>;
}

interface PendingPromptJump {
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

const NO_PROMPTS: ChatOutlinePrompt[] = [];

function sameTimeline(left: OutlineTimelineIdentity, right: OutlineTimelineIdentity): boolean {
  return (
    left.agentId === right.agentId &&
    left.serverId === right.serverId &&
    left.timelineEpoch === right.timelineEpoch &&
    left.enabled === right.enabled &&
    left.supportsPromptIndex === right.supportsPromptIndex
  );
}

/** Owns async index/jump requests; React supplies the viewed timeline, never another subscription. */
export function createOutlineNavigation(port: OutlineNavigationPort) {
  const activePrompt = createActivePromptPublisher();
  const listeners = new Set<() => void>();
  let input: OutlineNavigationInput | null = null;
  let index: AgentTimelinePromptIndexPayload | null = null;
  let pending: PendingPromptJump | null = null;
  let readingPosition: ReadingPosition | null = null;
  let indexRequestId = 0;
  let jumpRequestId = 0;

  function publishReadingPosition() {
    activePrompt.publish(
      resolveActivePromptSeq(index?.prompts ?? NO_PROMPTS, readingPosition?.seq ?? null),
    );
  }

  function publishIndex(next: AgentTimelinePromptIndexPayload | null) {
    index = next;
    publishReadingPosition();
    for (const listener of listeners) listener();
  }

  function findLoaded(seq: number): StreamItem | undefined {
    if (input === null) return undefined;
    return (
      input.tail.find((item) => item.timelineCursor?.seq === seq) ??
      input.head?.find((item) => item.timelineCursor?.seq === seq)
    );
  }

  function reconcileJump() {
    if (input === null || pending === null) return;
    const target = findLoaded(pending.seq);
    if (!target) {
      if (pending.fetchSettled) pending = null;
      return;
    }
    if (pending.hasScrolled) return;
    const isMounted =
      input.mountedHistoryMessageIds === undefined ||
      input.mountedHistoryMessageIds.has(target.id) ||
      input.head?.includes(target) === true;
    if (!isMounted) {
      input.revealLoadedMessage?.(target.id);
      return;
    }
    pending.hasScrolled = true;
    input.viewportRef.current?.scrollToMessage?.(target.id);
  }

  function cancelSelection() {
    jumpRequestId += 1;
    pending = null;
    activePrompt.request(null);
  }

  function jump(seq: number) {
    const requestId = ++jumpRequestId;
    pending = null;
    if (input === null || !input.enabled) return;
    const loaded = findLoaded(seq);
    if (loaded) {
      if (input.revealLoadedMessage?.(loaded.id)) {
        pending = { seq, fetchSettled: true, hasScrolled: false };
        return;
      }
      input.viewportRef.current?.scrollToMessage?.(loaded.id);
      return;
    }
    if (index === null) return;
    const identity = input;
    pending = { seq, fetchSettled: false, hasScrolled: false };
    void port
      .fetchTimeline(identity, planTimelinePromptJump({ epoch: index.epoch, seq }))
      .catch(() => {
        if (requestId === jumpRequestId) {
          pending = null;
          identity.onJumpError();
        }
      })
      .finally(() => {
        if (requestId !== jumpRequestId || pending === null) return;
        pending.fetchSettled = true;
      });
  }

  return {
    activePrompt,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPrompts: () => index?.prompts ?? NO_PROMPTS,
    update(next: OutlineNavigationInput) {
      const changed = input === null || !sameTimeline(input, next);
      const refresh = changed || input?.latestPromptSeq !== next.latestPromptSeq;
      input = next;
      if (changed) {
        indexRequestId += 1;
        cancelSelection();
        readingPosition = null;
        publishIndex(null);
      }
      reconcileJump();
      if (!refresh || !next.enabled || !next.supportsPromptIndex || next.timelineEpoch === null)
        return;
      const timelineEpoch = next.timelineEpoch;
      const request = port.listPrompts(next);
      if (request === null) return;
      const requestId = ++indexRequestId;
      void request
        .then((payload) => {
          if (
            requestId === indexRequestId &&
            shouldAcceptPromptIndexEpoch(timelineEpoch, payload.epoch)
          ) {
            publishIndex(payload);
          }
          return undefined;
        })
        .catch(() => undefined);
    },
    jumpToPrompt(seq: number) {
      activePrompt.request(null);
      jump(seq);
    },
    stepToPrompt(action: OutlineAccessibilityAction) {
      const prompts = index?.prompts ?? NO_PROMPTS;
      const seq = activePrompt.getRequestedSeq() ?? activePrompt.getActiveSeq();
      const activeIndex = prompts.findIndex((prompt) => prompt.seq === seq);
      const next = resolveOutlineAccessibilityIndex({ activeIndex, action, count: prompts.length });
      const prompt = next === null ? undefined : prompts[next];
      if (!prompt) return;
      // Reading geometry can stay on an older turn at offset zero. The adjustable
      // control advances its requested selection even when the list cannot move.
      activePrompt.request(prompt.seq);
      jump(prompt.seq);
    },
    cancelSelection,
    reportReadingPosition(position: ReadingPosition | null) {
      readingPosition = position;
      publishReadingPosition();
    },
    dispose() {
      indexRequestId += 1;
      cancelSelection();
      input = null;
    },
  };
}
