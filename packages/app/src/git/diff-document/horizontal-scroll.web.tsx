import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { DiffFileSection } from "./types";

export const HorizontalScroll = memo(function HorizontalScroll({
  file,
  initialOffset,
  onScroll,
}: {
  file: DiffFileSection;
  initialOffset: number;
  onScroll: (path: string, offset: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => onScroll(file.path, event.currentTarget.scrollLeft),
    [file.path, onScroll],
  );
  const rootStyle = useMemo<React.CSSProperties>(
    () => ({
      position: "absolute",
      left: 0,
      top: file.bodyTop,
      width: "100%",
      height: file.bodyHeight,
      overflowX: "auto",
      overflowY: "hidden",
      pointerEvents: "auto",
    }),
    [file.bodyHeight, file.bodyTop],
  );
  const spacerStyle = useMemo<React.CSSProperties>(
    () => ({ width: file.contentWidth, height: Math.max(1, file.bodyHeight) }),
    [file.bodyHeight, file.contentWidth],
  );
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollLeft = initialOffset;
    onScroll(file.path, element.scrollLeft);
  }, [file.path, initialOffset, onScroll]);
  return (
    <div
      ref={scrollRef}
      data-testid={`diff-file-${file.fileIndex}-horizontal-scroll`}
      onScroll={scroll}
      style={rootStyle}
    >
      <div style={spacerStyle} />
    </div>
  );
});
