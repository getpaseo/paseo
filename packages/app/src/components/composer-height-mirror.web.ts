import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

interface Args {
  value: string;
  textareaRef: RefObject<HTMLElement | null>;
  minHeight: number;
  maxHeight: number;
  onHeight: (height: number) => void;
}

const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "wordWrap",
  "overflowWrap",
  "wordBreak",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

export function useComposerHeightMirror({
  value,
  textareaRef,
  minHeight,
  maxHeight,
  onHeight,
}: Args): void {
  const paramsRef = useRef({ value, minHeight, maxHeight, onHeight });
  paramsRef.current = { value, minHeight, maxHeight, onHeight };

  const mirrorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mirror = document.createElement("textarea");
    mirror.setAttribute("aria-hidden", "true");
    mirror.setAttribute("tabindex", "-1");
    mirror.readOnly = true;
    mirror.rows = 1;
    const style = mirror.style;
    style.position = "absolute";
    style.top = "0";
    style.left = "0";
    style.visibility = "hidden";
    style.pointerEvents = "none";
    style.overflow = "hidden";
    style.border = "0";
    style.margin = "0";
    style.resize = "none";
    style.zIndex = "-1";
    style.boxSizing = "border-box";
    document.body.appendChild(mirror);
    mirrorRef.current = mirror;
    return () => {
      mirror.remove();
      mirrorRef.current = null;
    };
  }, []);

  const measure = useCallback(() => {
    const mirror = mirrorRef.current;
    const source = textareaRef.current;
    if (!mirror || !source || typeof window === "undefined") return;
    if (!(source instanceof HTMLElement)) return;

    const cs = window.getComputedStyle(source);
    const ms = mirror.style;
    for (const prop of COPIED_STYLES) {
      ms[prop] = cs[prop];
    }
    ms.width = `${source.clientWidth}px`;

    const {
      value: currentValue,
      minHeight: currentMinHeight,
      maxHeight: currentMaxHeight,
      onHeight: currentOnHeight,
    } = paramsRef.current;
    // Trailing newline is collapsed by textarea measurement — pad with a space.
    mirror.value = currentValue.endsWith("\n") ? `${currentValue} ` : currentValue;

    const next = Math.max(currentMinHeight, Math.min(currentMaxHeight, mirror.scrollHeight));
    currentOnHeight(next);
  }, [textareaRef]);

  useLayoutEffect(() => {
    measure();
  }, [value, measure]);

  useEffect(() => {
    const source = textareaRef.current;
    if (!source || !(source instanceof HTMLElement)) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(source);
    return () => observer.disconnect();
  }, [textareaRef, measure]);
}
