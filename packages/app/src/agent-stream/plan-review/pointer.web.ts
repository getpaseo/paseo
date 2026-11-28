import { useEffect } from "react";
import { isWeb } from "@/constants/platform";
import type { PlanSourcePointerOptions } from "./pointer";

export function usePlanSourcePointer({
  root,
  anchor,
  model,
  disabled,
  onComplete,
}: PlanSourcePointerOptions) {
  useEffect(() => {
    if (!isWeb || !root.current || disabled) return;
    const element = root.current as unknown as HTMLElement;
    let drag: {
      pointerId: number;
      anchor: number;
      end: number;
      previousStart: number;
      previousEnd: number;
      previousAnchor: number;
      previousTarget: "plan" | "lines";
    } | null = null;
    let suppressClick = false;
    function lineAt(target: EventTarget | null) {
      if (!(target instanceof Element)) return null;
      const row = target.closest<HTMLElement>("[data-plan-line]");
      return row && element.contains(row) ? Number(row.dataset.planLine) : null;
    }
    function down(event: PointerEvent) {
      suppressClick = false;
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const line = lineAt(event.target);
      if (line == null) return;
      event.preventDefault();
      const previous = model.getState();
      const start = event.shiftKey ? anchor.current : line;
      drag = {
        pointerId: event.pointerId,
        anchor: start,
        end: line,
        previousStart: Number(previous.start),
        previousEnd: Number(previous.end),
        previousAnchor: anchor.current,
        previousTarget: previous.commentTarget,
      };
      anchor.current = start;
      suppressClick = true;
      element.setPointerCapture(event.pointerId);
      model.selectLines(start, line);
    }
    function move(event: PointerEvent) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const line = lineAt(document.elementFromPoint(event.clientX, event.clientY));
      if (line == null || line === drag.end) return;
      drag.end = line;
      model.selectLines(drag.anchor, line);
    }
    function up(event: PointerEvent) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      move(event);
      drag = null;
      element.releasePointerCapture(event.pointerId);
      onComplete();
    }
    function cancel(event: PointerEvent) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      model.selectLines(drag.previousStart, drag.previousEnd);
      model.setCommentTarget(drag.previousTarget);
      anchor.current = drag.previousAnchor;
      drag = null;
    }
    function click(event: MouseEvent) {
      // Pointer gestures already committed the range; the synthetic click must preserve it.
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", cancel);
    element.addEventListener("click", click, true);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      element.removeEventListener("click", click, true);
    };
  }, [root, anchor, model, disabled, onComplete]);
}
