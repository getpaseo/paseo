import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputScrollEventData,
  TextStyle,
} from "react-native";
import { clampComposerHeight } from "./height-state";

interface ComposerHeightArgs {
  value: string;
  textareaRef: RefObject<HTMLElement | null>;
  minHeight: number;
  maxHeight: number;
  onHeightChange?: (height: number) => void;
}

interface ComposerHeightResult {
  style: TextStyle;
  scrollEnabled: boolean;
  onTextChange: (previousText: string, nextText: string) => void;
  onContentSizeChange: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
  onScroll: (event: NativeSyntheticEvent<TextInputScrollEventData>) => void;
  reset: () => void;
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
  value,
  textareaRef,
  minHeight,
  maxHeight,
  onHeightChange,
}: ComposerHeightArgs): ComposerHeightResult {
  const [height, setHeight] = useState(minHeight);
  const heightRef = useRef(minHeight);
  const paramsRef = useRef({ value, minHeight, maxHeight, onHeightChange });
  paramsRef.current = { value, minHeight, maxHeight, onHeightChange };
  const mirrorRef = useRef<HTMLTextAreaElement | null>(null);

  const setBoundedHeight = useCallback((nextHeight: number) => {
    const {
      minHeight: currentMin,
      maxHeight: currentMax,
      onHeightChange: onChange,
    } = paramsRef.current;
    const bounded = clampComposerHeight(nextHeight, {
      minHeight: currentMin,
      maxHeight: currentMax,
    });
    if (Math.abs(heightRef.current - bounded) < 1) return;
    heightRef.current = bounded;
    setHeight(bounded);
    onChange?.(bounded);
  }, []);

  const measure = useCallback(
    (text: string) => {
      const mirror = mirrorRef.current;
      const source = textareaRef.current;
      if (!mirror || !source || typeof window === "undefined") return;

      const computedStyle = window.getComputedStyle(source);
      for (const property of COPIED_STYLES) {
        mirror.style[property] = computedStyle[property];
      }
      mirror.style.width = `${source.clientWidth}px`;
      mirror.value = text.endsWith("\n") ? `${text} ` : text;
      setBoundedHeight(mirror.scrollHeight);
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
    measure(paramsRef.current.value);
    return () => {
      mirror.remove();
      mirrorRef.current = null;
    };
  }, [measure]);

  useLayoutEffect(() => {
    measure(value);
  }, [maxHeight, minHeight, value, measure]);

  useEffect(() => {
    const source = textareaRef.current;
    if (!source || typeof ResizeObserver === "undefined") return;
    let previousWidth = source.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = source.clientWidth;
      if (Math.abs(nextWidth - previousWidth) < 1) return;
      previousWidth = nextWidth;
      measure(paramsRef.current.value);
    });
    observer.observe(source);
    return () => observer.disconnect();
  }, [measure, textareaRef]);

  const onTextChange = useCallback(
    (_previousText: string, nextText: string) => measure(nextText),
    [measure],
  );
  const reset = useCallback(() => setBoundedHeight(minHeight), [minHeight, setBoundedHeight]);
  const onContentSizeChange = useCallback(
    (_event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => undefined,
    [],
  );
  const onScroll = useCallback(
    (_event: NativeSyntheticEvent<TextInputScrollEventData>) => undefined,
    [],
  );
  const style = useMemo(() => ({ height, minHeight, maxHeight }), [height, maxHeight, minHeight]);

  return {
    style,
    scrollEnabled: height >= maxHeight,
    onTextChange,
    onContentSizeChange,
    onScroll,
    reset,
  };
}
