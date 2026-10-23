import { useEffect, useRef, useState } from "react";

import {
  advanceTextReveal,
  beginTextReveal,
  completeTextReveal,
  isTextRevealPacingSupported,
  isTextRevealSettled,
  nextTextRevealFrame,
  retargetTextReveal,
  type TextRevealState,
  visibleRevealedText,
} from "@/agent-stream/text-reveal";
import { useRetainedPanelActive } from "@/components/retained-panel";
export type MarkdownPhase = "streaming" | "complete";

export interface UseRevealedTextOptions {
  /** Callers that know the text is not on screen pass false to skip the frame clock. */
  enabled?: boolean;
}

/**
 * Binds the paced reveal in @/agent-stream/text-reveal to a frame clock.
 *
 * All of the policy — what is revealed when, and where it is safe to cut — lives
 * in that module and is tested there. This hook only owns the requestAnimationFrame
 * wiring, so the rendered behavior is covered end to end by
 * `packages/app/e2e/browser/agent-stream-smoothness.spec.ts`.
 */
export function useRevealedText(
  text: string,
  phase: MarkdownPhase,
  options?: UseRevealedTextOptions,
): string {
  const pacingSupported = isTextRevealPacingSupported();
  const panelActive = useRetainedPanelActive();
  const enabled = (options?.enabled ?? true) && panelActive;
  const stateRef = useRef<TextRevealState>(beginTextReveal(text));
  const [, forceRender] = useState(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  stateRef.current = retargetTextReveal(stateRef.current, text);
  if (!enabled) {
    // Hidden content must be whole the next time it appears. Keeping the reveal
    // state settled also means re-enabling only paces text that arrives from here.
    stateRef.current = completeTextReveal(stateRef.current);
  }

  useEffect(() => {
    const settle = () => {
      lastFrameAtRef.current = null;
      const next = completeTextReveal(stateRef.current);
      if (next !== stateRef.current) {
        stateRef.current = next;
        forceRender((tick) => tick + 1);
      }
    };

    if (!enabled || !pacingSupported || phase !== "streaming") {
      settle();
      return;
    }
    if (isTextRevealSettled(stateRef.current)) {
      lastFrameAtRef.current = null;
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      settle();
      return;
    }

    const tick = (timestamp: number) => {
      frameRef.current = null;
      const frame = nextTextRevealFrame(lastFrameAtRef.current, timestamp);
      if (!frame) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameAtRef.current = frame.frameAtMs;

      const next = advanceTextReveal(stateRef.current, frame.elapsedMs);
      if (next !== stateRef.current) {
        stateRef.current = next;
        forceRender((count) => count + 1);
      }
      if (!isTextRevealSettled(stateRef.current)) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [enabled, text, pacingSupported, phase]);

  if (!enabled) {
    return text;
  }
  return pacingSupported
    ? visibleRevealedText(stateRef.current, { streaming: phase === "streaming" })
    : text;
}
