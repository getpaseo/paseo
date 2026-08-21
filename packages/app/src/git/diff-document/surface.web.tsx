import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewStyle } from "react-native";
import { DomOverlayScrollbar } from "@/components/ui/overlay-scrollbar/dom-overlay-scrollbar";
import { InlineReviewAddButton, InlineReviewThread } from "@/review";
import { DiffSubmoduleHeader, DiffSubmoduleStatus } from "@/git/diff-submodule-row";
import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import { DocumentFileHeader } from "./document-file-header";
import { hitTestDiffDocument, selectedSourceText } from "./hit-testing";
import { retainHorizontalOffsetMapForPaths } from "./horizontal-offsets";
import { HorizontalScroll } from "./horizontal-scroll.web";
import {
  buildDiffDocumentModel,
  FILE_HEADER_HEIGHT,
  resolveRelayoutScrollTop,
  retainReusableModels,
} from "./model";
import { paintWebViewport } from "./paint.web";
import { hasPointerDragStarted } from "./pointer-gesture";
import { createMeasuredAdvances } from "./text-measurement";
import { retainDiffViewport } from "./viewport";
import type {
  DiffHit,
  DiffSelection,
  DiffSurfaceProps,
  DiffTypography,
  TextMeasurer,
} from "./types";

const DEFAULT_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const RESIZE_SETTLE_DELAY_MS = 120;

export function DiffSurface(props: DiffSurfaceProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasScratchRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<ReturnType<typeof buildDiffDocumentModel> | null>(null);
  const previousModelRef = useRef<ReturnType<typeof buildDiffDocumentModel> | null>(null);
  const reusableModelRef = useRef<{
    dependencies: readonly unknown[];
    models: ReturnType<typeof buildDiffDocumentModel>[];
  } | null>(null);
  const consumedFocusRef = useRef<string | null>(null);
  const scrollTopRef = useRef(0);
  const horizontalOffsetsRef = useRef(new Map<string, number>());
  const selectionRef = useRef<DiffSelection | null>(null);
  const dragRef = useRef<{
    anchor: DiffSelection["anchor"];
    startX: number;
    startY: number;
    moved: boolean;
    dismissSelectionOnClick: boolean;
  } | null>(null);
  const frameRef = useRef<number | null>(null);
  const resizeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeReleaseFrameRef = useRef<number | null>(null);
  const resizePointerActiveRef = useRef(false);
  const pendingViewportRef = useRef({ width: 0, height: 0 });
  const forcePaintRef = useRef(true);
  const canvasWindowRef = useRef({ top: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [loadedTypography, setLoadedTypography] = useState<DiffTypography | null>(null);
  const [hoveredAffordance, setHoveredAffordance] = useState<{
    hit: Extract<DiffHit, { kind: "cell" }>;
    left: number;
    top: number;
  } | null>(null);
  const hasHoveredAffordanceRef = useRef(false);
  const family = props.displayPreferences.monoFontFamily.trim() || DEFAULT_MONO_STACK;
  useLayoutEffect(() => {
    const stats = (window as typeof window & { __PASEO_DIFF_REACT_STATS__?: { commits: number } })
      .__PASEO_DIFF_REACT_STATS__;
    if (stats) stats.commits += 1;
  });
  const desiredTypography = useMemo<DiffTypography>(
    () => ({
      family,
      size: props.displayPreferences.codeFontSize,
      lineHeight: Math.round(props.displayPreferences.codeFontSize * 1.5),
    }),
    [family, props.displayPreferences.codeFontSize],
  );
  const measurement = useMemo(
    () => (loadedTypography ? createWebTextMeasurer(loadedTypography) : null),
    [loadedTypography],
  );
  const reviewActions = props.mode.kind === "working" ? props.mode.reviewActions : undefined;
  const model = useMemo(() => {
    if (!loadedTypography || !measurement) {
      return emptyDiffDocumentModel({
        layout: props.displayPreferences.layout,
        wrapLines: props.displayPreferences.wrapLines,
        viewportWidth: viewport.width,
        lineHeight: desiredTypography.lineHeight,
      });
    }
    const dependencies = [
      props.files,
      props.submodules,
      props.displayPreferences.layout,
      props.displayPreferences.wrapLines,
      viewport.width,
      loadedTypography,
      measurement,
      props.palette,
      t,
    ] as const;
    const previous = reusableModelRef.current;
    const canReuse = previous?.dependencies.every(
      (dependency, index) => dependency === dependencies[index],
    );
    const reuseFrom = canReuse ? previous?.models : undefined;
    const next = buildDiffDocumentModel({
      files: props.files,
      submodules: props.submodules,
      collapsedFilePaths: props.collapsedFilePaths,
      collapsedSubmodulePaths: props.collapsedSubmodulePaths,
      layout: props.displayPreferences.layout,
      wrapLines: props.displayPreferences.wrapLines,
      viewportWidth: viewport.width,
      typography: loadedTypography,
      measureText: measurement,
      palette: props.palette,
      reviewActions,
      labels: {
        binary: t("workspace.git.diff.binaryFile"),
        tooLarge: t("workspace.git.diff.tooLarge"),
      },
      reuseFrom,
    });
    reusableModelRef.current = {
      dependencies,
      models: retainReusableModels(reuseFrom, next),
    };
    return next;
  }, [
    measurement,
    props.collapsedFilePaths,
    props.displayPreferences.layout,
    props.displayPreferences.wrapLines,
    props.files,
    props.submodules,
    props.collapsedSubmodulePaths,
    props.palette,
    reviewActions,
    t,
    desiredTypography.lineHeight,
    loadedTypography,
    viewport.width,
  ]);
  modelRef.current = model;

  const paint = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const currentModel = modelRef.current;
    if (!canvas || !currentModel || currentModel.viewportWidth <= 0 || viewport.height <= 0) return;
    const desiredHeight = Math.min(
      Math.max(currentModel.height, viewport.height),
      viewport.height * 3,
    );
    const currentWindow = canvasWindowRef.current;
    const viewportTop = scrollTopRef.current;
    const viewportBottom = viewportTop + viewport.height;
    const safeInset = viewport.height / 2;
    const mustRecenter =
      currentWindow.height !== desiredHeight ||
      viewportTop < currentWindow.top + safeInset ||
      viewportBottom > currentWindow.top + currentWindow.height - safeInset;
    if (!forcePaintRef.current && !mustRecenter) return;
    const forceFullPaint = forcePaintRef.current;
    forcePaintRef.current = false;
    const canvasHeight = desiredHeight;
    const ratio = window.devicePixelRatio || 1;
    const requestedCanvasTop = mustRecenter
      ? Math.min(
          Math.max(0, viewportTop - viewport.height),
          Math.max(0, currentModel.height - canvasHeight),
        )
      : currentWindow.top;
    const canvasTop = Math.round(requestedCanvasTop * ratio) / ratio;
    canvasWindowRef.current = { top: canvasTop, height: canvasHeight };
    const pixelWidth = Math.ceil(currentModel.viewportWidth * ratio);
    const pixelHeight = Math.ceil(canvasHeight * ratio);
    const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.top = `${canvasTop}px`;
    canvas.style.height = `${canvasHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (!measurement || !loadedTypography) return;
    const { paintTop, paintHeight } = shiftCanvasPixels({
      canvas,
      scratch:
        canvasScratchRef.current ?? (canvasScratchRef.current = document.createElement("canvas")),
      context,
      currentTop: currentWindow.top,
      nextTop: canvasTop,
      canvasHeight,
      pixelWidth,
      pixelHeight,
      ratio,
      canReuse: !forceFullPaint && !resized && currentWindow.height === canvasHeight,
    });
    paintWebViewport({
      context,
      model: currentModel,
      palette: props.palette,
      typography: loadedTypography,
      measureText: measurement,
      scrollTop: canvasTop,
      viewportWidth: currentModel.viewportWidth,
      viewportHeight: canvasHeight,
      horizontalOffsets: horizontalOffsetsRef.current,
      selection: selectionRef.current,
      devicePixelRatio: ratio,
      paintTop,
      paintHeight,
    });
  }, [loadedTypography, measurement, props.palette, viewport.height]);
  const schedulePaint = useCallback(
    (force = true) => {
      if (force) forcePaintRef.current = true;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
    },
    [paint],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const commitPendingViewport = () =>
      setViewport((current) => retainDiffViewport(current, pendingViewportRef.current));
    const clearResizeSettleTimer = () => {
      if (resizeSettleTimerRef.current === null) return;
      clearTimeout(resizeSettleTimerRef.current);
      resizeSettleTimerRef.current = null;
    };
    const handlePointerDown = () => {
      resizePointerActiveRef.current = true;
      clearResizeSettleTimer();
    };
    const handlePointerEnd = () => {
      if (!resizePointerActiveRef.current) return;
      resizePointerActiveRef.current = false;
      if (resizeReleaseFrameRef.current !== null) {
        cancelAnimationFrame(resizeReleaseFrameRef.current);
      }
      resizeReleaseFrameRef.current = requestAnimationFrame(() => {
        resizeReleaseFrameRef.current = null;
        commitPendingViewport();
      });
    };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextViewport = { width: entry.contentRect.width, height: entry.contentRect.height };
      pendingViewportRef.current = nextViewport;
      if (resizePointerActiveRef.current) return;
      setViewport((currentViewport) =>
        currentViewport.width > 0 && currentViewport.height > 0
          ? currentViewport
          : retainDiffViewport(currentViewport, nextViewport),
      );
      clearResizeSettleTimer();
      resizeSettleTimerRef.current = setTimeout(() => {
        resizeSettleTimerRef.current = null;
        commitPendingViewport();
      }, RESIZE_SETTLE_DELAY_MS);
    });
    observer.observe(root);
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    window.addEventListener("pointerup", handlePointerEnd, { capture: true });
    window.addEventListener("pointercancel", handlePointerEnd, { capture: true });
    return () => {
      observer.disconnect();
      clearResizeSettleTimer();
      if (resizeReleaseFrameRef.current !== null)
        cancelAnimationFrame(resizeReleaseFrameRef.current);
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      window.removeEventListener("pointerup", handlePointerEnd, { capture: true });
      window.removeEventListener("pointercancel", handlePointerEnd, { capture: true });
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([
        document.fonts.load(`400 ${desiredTypography.size}px ${desiredTypography.family}`),
        document.fonts.load(`600 ${desiredTypography.size}px ${desiredTypography.family}`),
      ]);
      await document.fonts.ready;
      if (!cancelled) setLoadedTypography(desiredTypography);
    })();
    return () => {
      cancelled = true;
    };
  }, [desiredTypography]);
  useLayoutEffect(() => {
    const previous = previousModelRef.current;
    const scroll = scrollRef.current;
    if (previous && scroll && previous !== model) {
      const nextScrollTop = resolveRelayoutScrollTop(previous, model, scroll.scrollTop);
      scrollTopRef.current = nextScrollTop;
      scroll.scrollTop = nextScrollTop;
    }
    previousModelRef.current = model;
  }, [model]);
  useLayoutEffect(() => {
    horizontalOffsetsRef.current = retainHorizontalOffsetMapForPaths(
      horizontalOffsetsRef.current,
      props.files.map((file) => file.path),
    );
  }, [props.files]);
  useLayoutEffect(schedulePaint, [model, schedulePaint]);
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Fast Refresh preserves refs while rerunning effects. Release ownership of the canceled
      // request so the refreshed renderer can schedule its first paint.
      frameRef.current = null;
    },
    [],
  );
  const mode = props.mode;
  const collapsedFilePaths = props.collapsedFilePaths;
  const onToggleFile = props.onToggleFile;
  useEffect(() => {
    if (mode.kind !== "working") return;
    const focusPath = mode.focusPath;
    if (!focusPath) return;
    const requestKey = `${mode.focusRequestId ?? "initial"}:${focusPath}`;
    if (consumedFocusRef.current === requestKey) return;
    if (collapsedFilePaths.has(focusPath)) onToggleFile(focusPath);
    const file = model.files.find((entry) => entry.path === focusPath);
    if (file && scrollRef.current) {
      scrollRef.current.scrollTop = file.top;
      consumedFocusRef.current = requestKey;
    }
  }, [collapsedFilePaths, mode, model.files, onToggleFile]);

  const handleVerticalScroll = useCallback(
    (scrollElement: HTMLDivElement) => {
      const scrollTop = scrollElement.scrollTop;
      scrollTopRef.current = scrollTop;
      if (hasHoveredAffordanceRef.current) {
        hasHoveredAffordanceRef.current = false;
        setHoveredAffordance(null);
      }
      const currentModel = modelRef.current;
      const currentWindow = canvasWindowRef.current;
      if (!currentModel || currentWindow.height === 0) {
        schedulePaint(false);
        return;
      }
      const viewportBottom = scrollTop + viewport.height;
      const safeInset = viewport.height / 2;
      const crossedSafeInset =
        scrollTop < currentWindow.top + safeInset ||
        viewportBottom > currentWindow.top + currentWindow.height - safeInset;
      if (!crossedSafeInset) return;
      const requestedTop = Math.min(
        Math.max(0, scrollTop - viewport.height),
        Math.max(0, currentModel.height - currentWindow.height),
      );
      const ratio = window.devicePixelRatio || 1;
      const nextTop = Math.round(requestedTop * ratio) / ratio;
      if (nextTop !== currentWindow.top) schedulePaint(false);
    },
    [schedulePaint, viewport.height],
  );
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onScroll = () => handleVerticalScroll(scroll);
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [handleVerticalScroll]);
  const handleHorizontalScroll = useCallback(
    (path: string, offset: number) => {
      horizontalOffsetsRef.current.set(path, offset);
      schedulePaint();
    },
    [schedulePaint],
  );
  const pointHit = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const currentModel = modelRef.current;
    const root = rootRef.current;
    if (!currentModel || !root) return null;
    const bounds = root.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const documentY = event.clientY - bounds.top + scrollTopRef.current;
    const file = currentModel.files.find(
      (entry) => entry.top <= documentY && documentY < entry.bottom,
    );
    return hitTestDiffDocument({
      model: currentModel,
      x,
      documentY,
      horizontalOffset: file ? (horizontalOffsetsRef.current.get(file.path) ?? 0) : 0,
    });
  }, []);
  const pointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-diff-header="true"], [data-diff-review="true"], [role="menuitem"], button, input, textarea',
        )
      )
        return;
      const dismissSelectionOnClick = selectionRef.current !== null;
      if (dismissSelectionOnClick) {
        selectionRef.current = null;
        schedulePaint();
      }
      const hit = pointHit(event);
      if (hit?.kind !== "cell") return;
      dragRef.current = {
        anchor: hit.position,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        dismissSelectionOnClick,
      };
      selectionRef.current = { anchor: hit.position, focus: hit.position };
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      schedulePaint();
    },
    [pointHit, schedulePaint],
  );
  const pointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag) {
        drag.moved = hasPointerDragStarted({
          startX: drag.startX,
          startY: drag.startY,
          x: event.clientX,
          y: event.clientY,
          alreadyDragging: drag.moved,
        });
      }
      const hit = pointHit(event);
      if (hit?.kind === "cell") {
        const row = modelRef.current?.rows[hit.position.rowIndex];
        const file = modelRef.current?.files[hit.position.fileIndex];
        const sideIndex =
          row?.kind === "line" && row.cells.length === 2 && hit.position.side === "new" ? 1 : 0;
        if (row && file) {
          const columnWidth = viewport.width / (row.kind === "line" ? row.cells.length : 1);
          const gutterBorder = sideIndex * columnWidth + file.gutterWidth;
          const rootBounds = rootRef.current?.getBoundingClientRect();
          const pointerX = rootBounds ? event.clientX - rootBounds.left : Number.NaN;
          if (hit.target && Number.isFinite(pointerX)) {
            hasHoveredAffordanceRef.current = true;
            setHoveredAffordance({
              hit,
              left: gutterBorder - 12,
              top: row.top - scrollTopRef.current + (modelRef.current!.lineHeight - 22) / 2,
            });
          } else {
            hasHoveredAffordanceRef.current = false;
            setHoveredAffordance(null);
          }
        }
      } else {
        hasHoveredAffordanceRef.current = false;
        setHoveredAffordance(null);
      }
      if (!drag || hit?.kind !== "cell") return;
      selectionRef.current = { anchor: drag.anchor, focus: hit.position };
      schedulePaint();
    },
    [pointHit, schedulePaint, viewport.width],
  );
  const pointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const hit = pointHit(event);
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const moved = drag
        ? hasPointerDragStarted({
            startX: drag.startX,
            startY: drag.startY,
            x: event.clientX,
            y: event.clientY,
            alreadyDragging: drag.moved,
          })
        : false;
      if (drag && !moved && drag.dismissSelectionOnClick) {
        selectionRef.current = null;
        schedulePaint();
        return;
      }
      if (drag && !moved && hit?.kind === "cell" && hit.target && reviewActions) {
        selectionRef.current = null;
        reviewActions.onStartComment(hit.target);
        schedulePaint();
      }
    },
    [pointHit, reviewActions, schedulePaint],
  );
  const cancelPointer = useCallback(() => {
    dragRef.current = null;
  }, []);
  const copy = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!selectionRef.current) return;
      event.clipboardData.setData("text/plain", selectedSourceText(model, selectionRef.current));
      event.preventDefault();
    },
    [model],
  );
  const rootStyle = useMemo<React.CSSProperties>(
    () => ({ ...ROOT_STYLE, background: props.palette.surface }),
    [props.palette.surface],
  );
  const contentStyle = useMemo<React.CSSProperties>(
    () => ({ ...CONTENT_STYLE, height: Math.max(model.height, viewport.height) }),
    [model.height, viewport.height],
  );
  const affordanceStyle = useMemo<ViewStyle>(
    () => ({
      ...AFFORDANCE_STYLE,
      left: hoveredAffordance?.left ?? 0,
      top: hoveredAffordance?.top ?? 0,
    }),
    [hoveredAffordance?.left, hoveredAffordance?.top],
  );
  const addHoveredComment = useCallback(() => {
    const target = hoveredAffordance?.hit.target;
    if (target) reviewActions?.onStartComment(target);
  }, [hoveredAffordance?.hit.target, reviewActions]);
  const canvasStyle = useMemo<React.CSSProperties>(
    () => ({
      ...CANVAS_STYLE,
      width: model.viewportWidth,
      fontFamily: (loadedTypography ?? desiredTypography).family,
      fontSize: (loadedTypography ?? desiredTypography).size,
    }),
    [desiredTypography, loadedTypography, model.viewportWidth],
  );

  return (
    <div data-testid="git-diff-canvas-root" ref={rootRef} style={rootStyle}>
      <div
        ref={scrollRef}
        data-testid="git-diff-scroll"
        data-overlay-scrollbar="true"
        tabIndex={0}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
        onCopy={copy}
        style={SCROLL_STYLE}
      >
        <div style={contentStyle} onMouseDown={preventDocumentMouseSelection}>
          <canvas ref={canvasRef} data-testid="git-diff-canvas" style={canvasStyle} />
          {model.sections.map((section) =>
            section.kind === "file" ? (
              <WebFileHeaderSection key={`file:${section.file.path}`} file={section.file}>
                <DocumentFileHeader
                  file={section.file}
                  selectedPath={props.selectedPath}
                  mode={props.mode}
                  onToggleFile={props.onToggleFile}
                  onSelectPath={props.onSelectPath}
                />
              </WebFileHeaderSection>
            ) : (
              <WebSubmoduleSection
                key={`submodule:${section.submodule.path}`}
                section={section.submodule}
                diffMode={props.submoduleDiffMode ?? "uncommitted"}
                onToggle={props.onToggleSubmodule}
              />
            ),
          )}
          {model.files
            .filter((file) => !file.isCollapsed && !model.wrapLines)
            .map((file) => (
              <HorizontalScroll
                key={file.path}
                file={file}
                initialOffset={horizontalOffsetsRef.current.get(file.path) ?? 0}
                onScroll={handleHorizontalScroll}
              />
            ))}
          {props.mode.kind === "working" && reviewActions
            ? model.rows.map((row) => {
                if (row.kind !== "line" || row.reviewHeight === 0) return null;
                const columnWidth = model.viewportWidth / row.cells.length;
                return row.cells.map((cell, index) => {
                  if (!cell?.reviewTarget) return null;
                  const comments = reviewActions.commentsByTarget.get(cell.reviewTarget.key) ?? [];
                  const hasEditor =
                    reviewActions.editor?.target.filePath === cell.reviewTarget.filePath &&
                    reviewActions.editor.target.side === cell.reviewTarget.side &&
                    reviewActions.editor.target.lineNumber === cell.reviewTarget.lineNumber;
                  if (comments.length === 0 && !hasEditor) return null;
                  return (
                    <WebReviewThread
                      key={cell.reviewTarget.key}
                      target={cell.reviewTarget}
                      actions={reviewActions}
                      top={row.top + row.height - row.reviewHeight}
                      left={index * columnWidth}
                      width={columnWidth}
                      height={row.reviewHeight}
                      pinToViewport={!model.wrapLines}
                    />
                  );
                });
              })
            : null}
        </div>
      </div>
      <DomOverlayScrollbar scrollContainerRef={scrollRef} onUserScrollUp={noop} />
      {hoveredAffordance?.hit.target && reviewActions ? (
        <InlineReviewAddButton onPress={addHoveredComment} style={affordanceStyle} />
      ) : null}
    </div>
  );
}

function WebSubmoduleSection({
  section,
  diffMode,
  onToggle,
}: {
  section: ReturnType<typeof buildDiffDocumentModel>["submodules"][number];
  diffMode: "uncommitted" | "base";
  onToggle: (path: string) => void;
}) {
  const headerStyle = useMemo<React.CSSProperties>(
    () => ({ ...SUBMODULE_SECTION_STYLE, top: section.top, height: section.headerHeight }),
    [section.headerHeight, section.top],
  );
  const statusStyle = useMemo<React.CSSProperties>(
    () => ({ ...SUBMODULE_SECTION_STYLE, top: section.statusTop, height: section.statusHeight }),
    [section.statusHeight, section.statusTop],
  );
  return (
    <>
      <div data-diff-header="true" style={headerStyle}>
        <DiffSubmoduleHeader
          submodule={section.submodule}
          bodyVisible={!section.isCollapsed}
          onToggle={onToggle}
          testID={`diff-submodule-${section.path}`}
        />
      </div>
      {section.statusHeight > 0 ? (
        <div style={statusStyle}>
          <DiffSubmoduleStatus
            submodule={section.submodule}
            depth={1}
            diffMode={diffMode}
            testID={`diff-submodule-${section.path}-status`}
          />
        </div>
      ) : null}
    </>
  );
}

function shiftCanvasPixels(input: {
  canvas: HTMLCanvasElement;
  scratch: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  currentTop: number;
  nextTop: number;
  canvasHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  ratio: number;
  canReuse: boolean;
}): { paintTop: number; paintHeight: number } {
  const delta = input.nextTop - input.currentTop;
  if (!input.canReuse || delta === 0 || Math.abs(delta) >= input.canvasHeight) {
    return { paintTop: 0, paintHeight: input.canvasHeight };
  }
  const deltaPixels = Math.round(Math.abs(delta) * input.ratio);
  const overlapPixels = input.pixelHeight - deltaPixels;
  if (input.scratch.width !== input.pixelWidth) input.scratch.width = input.pixelWidth;
  if (input.scratch.height !== input.pixelHeight) input.scratch.height = input.pixelHeight;
  const scratchContext = input.scratch.getContext("2d");
  if (!scratchContext) return { paintTop: 0, paintHeight: input.canvasHeight };
  scratchContext.setTransform(1, 0, 0, 1, 0, 0);
  scratchContext.globalCompositeOperation = "copy";
  scratchContext.drawImage(input.canvas, 0, 0);
  input.context.setTransform(1, 0, 0, 1, 0, 0);
  if (delta > 0) {
    input.context.drawImage(
      input.scratch,
      0,
      deltaPixels,
      input.pixelWidth,
      overlapPixels,
      0,
      0,
      input.pixelWidth,
      overlapPixels,
    );
    return { paintTop: input.canvasHeight - Math.abs(delta), paintHeight: Math.abs(delta) };
  }
  input.context.drawImage(
    input.scratch,
    0,
    0,
    input.pixelWidth,
    overlapPixels,
    0,
    deltaPixels,
    input.pixelWidth,
    overlapPixels,
  );
  return { paintTop: 0, paintHeight: Math.abs(delta) };
}

function WebFileHeaderSection({
  file,
  children,
}: {
  file: ReturnType<typeof buildDiffDocumentModel>["files"][number];
  children: React.ReactNode;
}) {
  const style = useMemo<React.CSSProperties>(
    () => ({ ...FILE_SECTION_STYLE, top: file.top, height: file.bottom - file.top }),
    [file.bottom, file.top],
  );
  return (
    <div style={style}>
      <div
        data-diff-header="true"
        style={STICKY_HEADER_STYLE}
        onMouseDown={preventDocumentMouseSelection}
      >
        {children}
      </div>
      <div data-testid={`diff-file-${file.fileIndex}-body`} style={BODY_MARKER_STYLE} />
    </div>
  );
}

function preventDocumentMouseSelection(event: React.MouseEvent): void {
  if (event.detail < 2) return;
  const target = event.target;
  if (target instanceof Element && target.closest('[data-diff-review="true"]')) return;
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
}

function WebReviewThread({
  target,
  actions,
  top,
  left,
  width,
  height,
  pinToViewport,
}: {
  target: ReviewableDiffTarget;
  actions: NonNullable<Extract<DiffSurfaceProps["mode"], { kind: "working" }>["reviewActions"]>;
  top: number;
  left: number;
  width: number;
  height: number;
  pinToViewport: boolean;
}) {
  const style = useMemo<React.CSSProperties>(
    () => ({ ...REVIEW_STYLE, top, left, width, height }),
    [height, left, top, width],
  );
  return (
    <div style={style} data-diff-review="true">
      <InlineReviewThread
        reviewTarget={target}
        reviewActions={actions}
        height={height}
        viewportWidth={width}
        pinToViewport={pinToViewport}
      />
    </div>
  );
}

const ROOT_STYLE: React.CSSProperties = {
  position: "relative",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};
const SCROLL_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  overflowY: "auto",
  overflowX: "hidden",
  scrollbarWidth: "none",
  cursor: "text",
};

function noop(): void {}
const CONTENT_STYLE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  userSelect: "none",
};
const FILE_SECTION_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  zIndex: 3,
  pointerEvents: "none",
};
const SUBMODULE_SECTION_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  // Above canvas rows (z1), below the sticky file headers inside FILE_SECTION_STYLE
  // (z3). The submodule header is fixed at its document top, not sticky, so a
  // sticky file header scrolling over it must render in front.
  zIndex: 2,
  pointerEvents: "auto",
  userSelect: "none",
};
const STICKY_HEADER_STYLE: React.CSSProperties = {
  position: "sticky",
  top: 0,
  pointerEvents: "auto",
  userSelect: "none",
};
const BODY_MARKER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: FILE_HEADER_HEIGHT,
  bottom: 0,
  left: 0,
  right: 0,
  pointerEvents: "none",
};
const REVIEW_STYLE: React.CSSProperties = { position: "absolute", zIndex: 4, userSelect: "text" };
const CANVAS_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  zIndex: 1,
  pointerEvents: "none",
};
const AFFORDANCE_STYLE: ViewStyle = {
  position: "absolute",
  zIndex: 5,
};

function emptyDiffDocumentModel(input: {
  layout: "unified" | "split";
  wrapLines: boolean;
  viewportWidth: number;
  lineHeight: number;
}): ReturnType<typeof buildDiffDocumentModel> {
  return {
    files: [],
    submodules: [],
    sections: [],
    rows: [],
    height: 0,
    lineHeight: input.lineHeight,
    layout: input.layout,
    wrapLines: input.wrapLines,
    viewportWidth: input.viewportWidth,
  };
}

function createWebTextMeasurer(typography: DiffTypography): TextMeasurer {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return { measure: () => 0 };
  const measure = (text: string, weight: "regular" | "semibold" = "regular") => {
    context.font = `${weight === "semibold" ? 600 : 400} ${typography.size}px ${typography.family}`;
    return context.measureText(text).width;
  };
  // Canvas exposes no glyph coverage, so `requiresShaping` alone decides which
  // runs a shaper has to see -- there is no `glyphIds` to fall back on.
  return { measure, measureAdvances: createMeasuredAdvances((text) => measure(text)) };
}
