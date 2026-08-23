import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputScrollEventData,
  TextStyle,
} from "react-native";
import { reduceNativeComposerHeight, type NativeComposerHeightEvent } from "./height-state";

interface ComposerHeightArgs {
  value: string;
  textareaRef: RefObject<unknown>;
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

export function useComposerHeight({
  value,
  minHeight,
  maxHeight,
  onHeightChange,
}: ComposerHeightArgs): ComposerHeightResult {
  const [height, setHeight] = useState(minHeight);
  const heightRef = useRef(minHeight);
  const didRemeasureInitialValueRef = useRef(false);
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  const apply = useCallback(
    (event: NativeComposerHeightEvent) => {
      const nextHeight = reduceNativeComposerHeight(
        heightRef.current,
        { minHeight, maxHeight },
        event,
      );
      if (Math.abs(nextHeight - heightRef.current) < 1) return;
      heightRef.current = nextHeight;
      setHeight(nextHeight);
      onHeightChangeRef.current?.(nextHeight);
    },
    [maxHeight, minHeight],
  );

  useEffect(() => {
    apply({ type: "content-measured", height: heightRef.current });
  }, [apply]);

  useEffect(() => {
    if (didRemeasureInitialValueRef.current || value.length === 0) return;
    didRemeasureInitialValueRef.current = true;
    apply({ type: "remeasure" });
  }, [apply, value]);

  const onTextChange = useCallback(
    (previousText: string, nextText: string) => {
      apply({ type: "text-changed", previousText, nextText });
    },
    [apply],
  );

  const onContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      apply({ type: "content-measured", height: event.nativeEvent.contentSize.height });
    },
    [apply],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<TextInputScrollEventData>) => {
      // iOS Fabric can omit the first content-size callback when a fixed-height input overflows.
      // The caret-scroll event still carries the actual size and bootstraps the same state.
      const nativeEvent = event.nativeEvent as TextInputScrollEventData & {
        contentSize?: { width: number; height: number };
      };
      const contentHeight = nativeEvent.contentSize?.height;
      if (contentHeight !== undefined) {
        apply({ type: "content-measured", height: contentHeight });
      }
    },
    [apply],
  );

  const reset = useCallback(() => apply({ type: "reset" }), [apply]);
  const style = useMemo(() => ({ height, minHeight, maxHeight }), [height, maxHeight, minHeight]);

  // A non-scrolling UITextView reports its frame as contentSize. Scrolling stays enabled so
  // caret overflow can expose the intrinsic size through onScroll.
  return { style, scrollEnabled: true, onTextChange, onContentSizeChange, onScroll, reset };
}
