import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildMinimapChangeRanges,
  buildMinimapLines,
  type MinimapChange,
  minimapScale,
  minimapSlider,
  scrollTopForMinimapPointer,
} from "./minimap-geometry";
import type { DiffDocumentModel, DiffPalette } from "./types";

export const MINIMAP_WIDTH = 72;
const CODE_LEFT = 8;
const CODE_RIGHT_INSET = 10;
const CODE_COLUMNS = 100;
const MARKER_WIDTH = 4;
const MARKER_MIN_HEIGHT = 3;

interface DiffMinimapProps {
  model: DiffDocumentModel;
  palette: DiffPalette;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewportHeight: number;
}

/**
 * A scaled picture of the document beside the diff, in the manner of an editor minimap:
 * code shapes, change bands, and a slider for the visible region. Pressing anywhere
 * scrolls there; dragging the slider scrubs.
 */
export function DiffMinimap({ model, palette, scrollRef, viewportHeight }: DiffMinimapProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const grabOffsetRef = useRef<number | null>(null);
  const [height, setHeight] = useState(0);
  const [hovered, setHovered] = useState(false);
  const lines = useMemo(() => buildMinimapLines(model), [model]);
  const ranges = useMemo(() => buildMinimapChangeRanges(lines), [lines]);
  const scale = minimapScale({
    documentHeight: model.height,
    minimapHeight: height,
    lineHeight: model.lineHeight,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || height <= 0 || scale <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(MINIMAP_WIDTH * ratio);
    canvas.height = Math.ceil(height * ratio);
    canvas.style.width = `${MINIMAP_WIDTH}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, MINIMAP_WIDTH, height);

    const codeWidth = MINIMAP_WIDTH - CODE_LEFT - CODE_RIGHT_INSET;
    const columnWidth = codeWidth / CODE_COLUMNS;
    for (const line of lines) {
      const top = line.top * scale;
      const lineHeight = Math.max(1, line.height * scale);
      if (line.change) {
        context.globalAlpha = 1;
        context.fillStyle = changeBackground(line.change, palette);
        context.fillRect(0, top, MINIMAP_WIDTH - MARKER_WIDTH, lineHeight);
      }
      if (line.length <= 0) continue;
      const left = CODE_LEFT + Math.min(line.indent, CODE_COLUMNS) * columnWidth;
      const width = Math.min(line.length, CODE_COLUMNS - line.indent) * columnWidth;
      if (width <= 0) continue;
      context.globalAlpha = line.change ? 0.9 : 0.35;
      context.fillStyle = line.change
        ? changeForeground(line.change, palette)
        : palette.foregroundMuted;
      context.fillRect(left, top + lineHeight * 0.2, width, Math.max(1, lineHeight * 0.6));
    }

    context.globalAlpha = 1;
    for (const range of ranges) {
      const top = range.top * scale;
      const markerHeight = Math.max(MARKER_MIN_HEIGHT, (range.bottom - range.top) * scale);
      if (range.change === "modify") {
        context.fillStyle = palette.deletion;
        context.fillRect(MINIMAP_WIDTH - MARKER_WIDTH, top, MARKER_WIDTH / 2, markerHeight);
        context.fillStyle = palette.addition;
        context.fillRect(MINIMAP_WIDTH - MARKER_WIDTH / 2, top, MARKER_WIDTH / 2, markerHeight);
        continue;
      }
      context.fillStyle = changeForeground(range.change, palette);
      context.fillRect(MINIMAP_WIDTH - MARKER_WIDTH, top, MARKER_WIDTH, markerHeight);
    }
  }, [height, lines, palette, ranges, scale]);

  const syncSlider = useCallback(() => {
    const slider = sliderRef.current;
    const scroll = scrollRef.current;
    if (!slider || !scroll) return;
    const geometry = minimapSlider({ scale, scrollTop: scroll.scrollTop, viewportHeight });
    slider.style.transform = `translateY(${geometry.top}px)`;
    slider.style.height = `${geometry.height}px`;
  }, [scale, scrollRef, viewportHeight]);

  useLayoutEffect(() => {
    syncSlider();
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.addEventListener("scroll", syncSlider, { passive: true });
    return () => scroll.removeEventListener("scroll", syncSlider);
  }, [model, scrollRef, syncSlider]);

  const scrollToPointer = useCallback(
    (clientY: number, grabOffset: number) => {
      const root = rootRef.current;
      const scroll = scrollRef.current;
      if (!root || !scroll) return;
      scroll.scrollTop = scrollTopForMinimapPointer({
        y: clientY - root.getBoundingClientRect().top,
        grabOffset,
        scale,
        documentHeight: model.height,
        viewportHeight,
      });
    },
    [model.height, scale, scrollRef, viewportHeight],
  );

  const pointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || scale <= 0) return;
      const root = rootRef.current;
      const scroll = scrollRef.current;
      if (!root || !scroll) return;
      event.preventDefault();
      const y = event.clientY - root.getBoundingClientRect().top;
      const slider = minimapSlider({ scale, scrollTop: scroll.scrollTop, viewportHeight });
      const onSlider = y >= slider.top && y <= slider.top + slider.height;
      // Grabbing the slider keeps its offset; pressing elsewhere centers the viewport there.
      const grabOffset = onSlider ? y - slider.top : slider.height / 2;
      grabOffsetRef.current = grabOffset;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollToPointer(event.clientY, grabOffset);
    },
    [scale, scrollRef, scrollToPointer, viewportHeight],
  );

  const pointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const grabOffset = grabOffsetRef.current;
      if (grabOffset === null) return;
      scrollToPointer(event.clientY, grabOffset);
    },
    [scrollToPointer],
  );

  const pointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    grabOffsetRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const rootStyle = useMemo<React.CSSProperties>(
    () => ({
      ...ROOT_STYLE,
      background: palette.surface,
      borderLeft: `1px solid ${palette.border}`,
    }),
    [palette.border, palette.surface],
  );
  const sliderStyle = useMemo<React.CSSProperties>(
    () => ({
      ...SLIDER_STYLE,
      background: palette.foreground,
      opacity: hovered ? 0.14 : 0.08,
      display: scale > 0 ? "block" : "none",
    }),
    [hovered, palette.foreground, scale],
  );
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  return (
    <div
      ref={rootRef}
      data-testid="git-diff-minimap"
      aria-label={t("workspace.git.diff.minimap")}
      role="scrollbar"
      aria-orientation="vertical"
      style={rootStyle}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} style={CANVAS_STYLE} />
      <div ref={sliderRef} data-testid="git-diff-minimap-slider" style={sliderStyle} />
    </div>
  );
}

function changeForeground(change: MinimapChange, palette: DiffPalette): string {
  return change === "remove" ? palette.deletion : palette.addition;
}

function changeBackground(change: MinimapChange, palette: DiffPalette): string {
  return change === "remove" ? palette.deletionBackground : palette.additionBackground;
}

const ROOT_STYLE: React.CSSProperties = {
  position: "relative",
  flexShrink: 0,
  width: MINIMAP_WIDTH,
  minHeight: 0,
  overflow: "hidden",
  cursor: "default",
  userSelect: "none",
  touchAction: "none",
};
const CANVAS_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
};
const SLIDER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  pointerEvents: "none",
  willChange: "transform",
};
