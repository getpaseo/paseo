import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatOpenPosition } from "@/hooks/use-settings";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";
import type { BottomAnchorRouteRequest } from "./bottom-anchor-controller";

type OpenState =
  | { status: "idle" | "loading" | "error" }
  | { status: "positioning"; sequenceNumber: number };

export function useChatOpenPosition(input: {
  agentId: string;
  serverId: string;
  active: boolean;
  position: ChatOpenPosition;
  ready: boolean;
  epoch: string | null;
  supportsPromptIndex: boolean;
  items: StreamItem[];
  head: StreamItem[] | undefined;
  mountedMessageIds: { has(id: string): boolean };
  revealLoadedMessage: (messageId: string) => boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  bottomAnchorRequest: BottomAnchorRouteRequest | null;
}) {
  const {
    agentId,
    serverId,
    active,
    position,
    ready,
    epoch,
    supportsPromptIndex,
    viewportRef,
    mountedMessageIds,
    revealLoadedMessage,
  } = input;
  const [state, setState] = useState<OpenState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const cancelPending = useRef<() => void>(() => {});
  const findMessage = useStableEvent(
    (sequenceNumber: number) =>
      input.items.find((item) => item.timelineCursor?.seq === sequenceNumber) ??
      input.head?.find((item) => item.timelineCursor?.seq === sequenceNumber),
  );

  useEffect(() => {
    if (!active || position !== "start" || !ready || epoch === null) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    cancelPending.current = cancel;
    viewportRef.current?.holdReadingPosition();
    setState({ status: "loading" });
    const load = async () => {
      const runtime = getHostRuntimeStore();
      const client = runtime.getClient(serverId);
      if (!client || !supportsPromptIndex) throw new Error("Timeline prompt index unavailable");
      const index = await client.listAgentTimelinePrompts(agentId);
      if (cancelled) return;
      if (index.epoch !== epoch) throw new Error("Timeline changed while opening chat");
      const first = index.prompts[0];
      if (!first) {
        setState({ status: "idle" });
        return;
      }
      if (!findMessage(first.seq)) {
        await runtime.fetchAgentTimeline(
          serverId,
          agentId,
          planTimelinePromptJump({ epoch, seq: first.seq }),
        );
      }
      if (!cancelled) setState({ status: "positioning", sequenceNumber: first.seq });
    };
    void load().catch(() => {
      if (!cancelled) setState({ status: "error" });
    });
    return cancel;
  }, [
    active,
    agentId,
    attempt,
    epoch,
    findMessage,
    position,
    ready,
    serverId,
    supportsPromptIndex,
    viewportRef,
  ]);

  useEffect(() => {
    if (!active || state.status !== "positioning") return;
    const target = findMessage(state.sequenceNumber);
    if (!target) {
      setState({ status: "error" });
      return;
    }
    const messageId = getStreamItemMessageId(target);
    if (!mountedMessageIds.has(messageId)) {
      revealLoadedMessage(messageId);
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.holdReadingPosition();
    if (viewport.scrollToMessage) viewport.scrollToMessage(messageId);
    else viewport.scrollToStart?.();
    setState({ status: "idle" });
  }, [active, findMessage, mountedMessageIds, revealLoadedMessage, state, viewportRef]);

  const cancel = useStableEvent(() => {
    cancelPending.current();
    setState({ status: "idle" });
  });
  // The reader scrolled or a find match moved the list. A pending opening must not pull them back
  // later; an error stays until they retry or go to the bottom. Runs on every wheel and touch
  // move, so it only touches state while an opening is pending.
  const yieldToReader = useStableEvent(() => {
    if (state.status !== "loading" && state.status !== "positioning") return;
    cancel();
  });
  const retry = useStableEvent(() => setAttempt((value) => value + 1));
  return {
    status: state.status,
    cancel,
    yieldToReader,
    retry,
    bottomAnchorRequest: position === "start" ? null : input.bottomAnchorRequest,
  };
}
