import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ComposerHeightResult } from "./height.types";

interface ComposerHeightArgs {
  getText: () => string;
  textareaRef: RefObject<HTMLElement | null>;
  minHeight: number;
  maxHeight: number;
  onRenderedLinesChange?: (lines: number) => void;
  presentationKey?: boolean;
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

export function useComposerHeight({
  getText,
  textareaRef,
  minHeight,
  maxHeight,
  onRenderedLinesChange,
  presentationKey,
}: ComposerHeightArgs): ComposerHeightResult {
  const [height, setHeight] = useState(minHeight);
  const heightRef = useRef(minHeight);
  const naturalHeightRef = useRef(minHeight);
  const paramsRef = useRef({ getText, minHeight, maxHeight, onRenderedLinesChange });
  paramsRef.current = { getText, minHeight, maxHeight, onRenderedLinesChange };
  const mirrorRef = useRef<HTMLTextAreaElement | null>(null);

  const setBoundedHeight = useCallback((nextHeight: number) => {
    const { minHeight: currentMin, maxHeight: currentMax } = paramsRef.current;
    const bounded = Math.max(currentMin, Math.min(currentMax, nextHeight));
    if (Math.abs(heightRef.current - bounded) < 1) return;
    heightRef.current = bounded;
    setHeight(bounded);
  }, []);

  const measure = useCallback(
    (text: string) => {
      const mirror = mirrorRef.current;
      const source = textareaRef.current;
      if (!mirror || !source || typeof window === "undefined") return;
      const sourceWidth = source.clientWidth;
      if (sourceWidth <= 0) return;

      const computedStyle = window.getComputedStyle(source);
      for (const property of COPIED_STYLES) {
        mirror.style[property] = computedStyle[property];
      }
      mirror.style.width = `${sourceWidth}px`;
      mirror.value = text.endsWith("\n") ? `${text} ` : text;
      const padding =
        parseFloat(computedStyle.paddingTop) + parseFloat(computedStyle.paddingBottom);
      const lineHeight = parseFloat(computedStyle.lineHeight);
      const naturalHeight = mirror.scrollHeight;
      naturalHeightRef.current = naturalHeight;
      if (lineHeight > 0)
        paramsRef.current.onRenderedLinesChange?.(
          Math.round((naturalHeight - padding) / lineHeight),
        );
      setBoundedHeight(naturalHeight);
    },
    [setBoundedHeight, textareaRef],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mirror = document.createElement("textarea");
    mirror.setAttribute("aria-hidden", "true");
    mirror.setAttribute("tabindex", "-1");
    mirror.readOnly = true;
    mirror.rows = 1;
    Object.assign(mirror.style, {
      position: "absolute",
      top: "0",
      left: "0",
      visibility: "hidden",
      pointerEvents: "none",
      overflow: "hidden",
      border: "0",
      margin: "0",
      resize: "none",
      zIndex: "-1",
      boxSizing: "border-box",
    });
    document.body.appendChild(mirror);
    mirrorRef.current = mirror;
    measure(paramsRef.current.getText());
    return () => {
      mirror.remove();
      mirrorRef.current = null;
    };
  }, [measure]);

  useLayoutEffect(() => {
    measure(getText());
  }, [getText, measure, presentationKey]);

  useLayoutEffect(() => {
    setBoundedHeight(naturalHeightRef.current);
  }, [maxHeight, minHeight, setBoundedHeight]);

  useEffect(() => {
    const source = textareaRef.current;
    if (!source || typeof ResizeObserver === "undefined") return;
    let previousWidth: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      // Hint padding changes the width text wraps at even when clientWidth stays fixed.
      const nextWidth = entry.contentRect.width;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      measure(paramsRef.current.getText());
    });
    observer.observe(source);
    return () => observer.disconnect();
  }, [measure, textareaRef, presentationKey]);

  const onTextChange = useCallback(
    (_previousText: string, nextText: string) => measure(nextText),
    [measure],
  );
  const reset = useCallback(() => {
    naturalHeightRef.current = minHeight;
    setBoundedHeight(minHeight);
  }, [minHeight, setBoundedHeight]);
  // The mirror already clamps the textarea. Only its effective height changes the CSS rule.
  const visibleHeight = Math.min(height, maxHeight);
  const style = useMemo(() => ({ height: visibleHeight, minHeight }), [visibleHeight, minHeight]);

  return {
    mode: "measured",
    style,
    scrollEnabled: height >= maxHeight,
    onTextChange,
    reset,
  };
}
