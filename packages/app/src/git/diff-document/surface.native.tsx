import { Canvas, Group, Picture, type SkPicture } from "@shopify/react-native-skia";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import Animated, {
  createAnimatedComponent,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { InlineReviewThread } from "@/review";
import { useKeyboardShift } from "@/hooks/keyboard-shift-context";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { DocumentFileHeader } from "./document-file-header";
import {
  diffInteractionWindowTop,
  diffMaterializationWindow,
  resolveVisibleFileSections,
} from "./header-layout";
import { hitTestDiffBodyPoint } from "./native-hit-testing";
import { retainDiffViewport } from "./viewport";
import { HorizontalScroll } from "./horizontal-scroll.native";
import {
  horizontalOffsetForPath,
  retainHorizontalOffsetsForPaths,
  type DiffHorizontalOffsets,
} from "./horizontal-offsets";
import {
  buildDiffDocumentModel,
  resolveRelayoutScrollTop,
  retainReusableModels,
  shouldApplyRelayoutScroll,
} from "./model";
import {
  buildNativeCanvasSlabs,
  nativeCanvasSlabsForViewport,
  nativeCanvasWindowBucket,
  nativeCanvasWindowTop,
  type NativeCanvasSlab,
} from "./native-slabs";
import {
  createNativePaints,
  recordNativeHeaderPicture,
  recordNativeSlabPictures,
  type NativePaints,
} from "./paint.native";
import {
  createNativeTextLayoutStore,
  createNativeHeaderTextLayout,
  createNativeTextMeasurer,
  disposeNativeTextLayout,
  prepareNativeTextLayout,
  type NativeTextLayout,
  type NativeHeaderTextLayout,
} from "./text.native";
import type {
  DiffDocumentModel,
  DiffFileSection,
  DiffSurfaceProps,
  DiffTypography,
  TextMeasurer,
} from "./types";

const AnimatedScrollView = createAnimatedComponent(ScrollView);
const SYSTEM_MONO = "monospace";
const CODE_LEFT_PADDING = 8;

export function DiffSurface(props: DiffSurfaceProps) {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fileWindowTop, setFileWindowTop] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const previousModelRef = useRef<ReturnType<typeof buildDiffDocumentModel> | null>(null);
  const reusableModelRef = useRef<{
    dependencies: readonly unknown[];
    models: ReturnType<typeof buildDiffDocumentModel>[];
  } | null>(null);
  const consumedFocusRef = useRef<string | null>(null);
  const scrollTop = useSharedValue(0);
  const { shift: keyboardShift } = useKeyboardShift();
  const keyboardSpacerStyle = useAnimatedStyle(
    () => ({ height: keyboardShift.value }),
    [keyboardShift],
  );
  const horizontalOffsets = useSharedValue<DiffHorizontalOffsets>({});
  const family = props.displayPreferences.monoFontFamily.trim() || SYSTEM_MONO;
  const typography = useMemo<DiffTypography>(
    () => ({
      family,
      size: props.displayPreferences.codeFontSize,
      lineHeight: Math.round(props.displayPreferences.codeFontSize * 1.5),
    }),
    [family, props.displayPreferences.codeFontSize],
  );
  const measurement = useMemo<TextMeasurer>(
    () => createNativeTextMeasurer({ configuredFamily: family, fontSize: typography.size }),
    [family, typography.size],
  );
  const reviewActions = props.mode.kind === "working" ? props.mode.reviewActions : undefined;
  const model = useMemo(() => {
    const dependencies = [
      props.displayPreferences.layout,
      props.displayPreferences.wrapLines,
      viewport.width,
      typography,
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
      files: viewport.width > 0 ? props.files : [],
      collapsedFilePaths: props.collapsedFilePaths,
      layout: props.displayPreferences.layout,
      wrapLines: props.displayPreferences.wrapLines,
      viewportWidth: viewport.width,
      typography,
      measureText: measurement,
      palette: props.palette,
      reviewActions,
      labels: {
        binary: t("workspace.git.diff.binaryFile"),
        tooLarge: t("workspace.git.diff.tooLarge"),
      },
      materializationWindow: diffMaterializationWindow(fileWindowTop, viewport.height),
      reuseFrom,
    });
    reusableModelRef.current = {
      dependencies,
      models: retainReusableModels(reuseFrom, next),
    };
    return next;
  }, [
    measurement,
    fileWindowTop,
    props.collapsedFilePaths,
    props.displayPreferences.layout,
    props.displayPreferences.wrapLines,
    props.files,
    props.palette,
    reviewActions,
    t,
    typography,
    viewport.width,
    viewport.height,
  ]);
  const paints = useMemo(() => createNativePaints(props.palette), [props.palette]);
  const textLayoutStore = useMemo(
    () =>
      createNativeTextLayoutStore({
        configuredFamily: family,
        fontSize: typography.size,
        lineHeight: typography.lineHeight,
        palette: props.palette,
      }),
    [family, props.palette, typography.lineHeight, typography.size],
  );
  const textLayout = useMemo(
    () =>
      prepareNativeTextLayout(
        textLayoutStore,
        model,
        diffMaterializationWindow(fileWindowTop, viewport.height),
      ),
    [model, textLayoutStore, fileWindowTop, viewport.height],
  );
  useEffect(() => () => disposeNativeTextLayout(textLayoutStore), [textLayoutStore]);
  const headerTextLayout = useMemo(
    () =>
      createNativeHeaderTextLayout({
        configuredFamily: props.headerTypography.family,
        fontSize: props.headerTypography.size,
        statFontSize: props.headerTypography.statSize,
        palette: props.palette,
      }),
    [props.headerTypography, props.palette],
  );
  const updateFileWindow = useCallback((nextTop: number) => {
    setFileWindowTop((current) => (current === nextTop ? current : nextTop));
  }, []);
  useAnimatedReaction(
    () => diffInteractionWindowTop(scrollTop.value, viewport.height),
    (windowTop, previous) => {
      if (windowTop !== previous) {
        scheduleOnRN(updateFileWindow, windowTop);
      }
    },
    [updateFileWindow, viewport.height],
  );
  const interactionFiles = useMemo(
    () =>
      resolveVisibleFileSections({
        files: model.files,
        scrollTop: fileWindowTop,
        viewportHeight: viewport.height,
        overscan: viewport.height * 2,
      }).files,
    [fileWindowTop, model.files, viewport.height],
  );

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollTop.value = event.contentOffset.y;
  });

  const layout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => retainDiffViewport(current, { width, height }));
  }, []);
  useLayoutEffect(() => {
    const previous = previousModelRef.current;
    if (previous && previous !== model) {
      const nextScrollTop = resolveRelayoutScrollTop(previous, model, scrollTop.value);
      if (shouldApplyRelayoutScroll(scrollTop.value, nextScrollTop)) {
        scrollTop.value = nextScrollTop;
        scrollRef.current?.scrollTo({ y: nextScrollTop, animated: false });
      }
    }
    previousModelRef.current = model;
  }, [model, scrollTop]);
  useLayoutEffect(() => {
    horizontalOffsets.value = retainHorizontalOffsetsForPaths(
      horizontalOffsets.value,
      model.files.map((file) => file.path),
    );
  }, [horizontalOffsets, model.files]);

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
    if (file) {
      scrollTop.value = file.top;
      scrollRef.current?.scrollTo({ y: file.top, animated: false });
      consumedFocusRef.current = requestKey;
    }
  }, [collapsedFilePaths, mode, model.files, onToggleFile, scrollTop]);
  const contentStyle = useMemo(
    () => ({ minHeight: Math.max(model.height, viewport.height), backgroundColor: "transparent" }),
    [model.height, viewport.height],
  );
  return (
    <View style={[styles.root, { backgroundColor: props.palette.surface }]} onLayout={layout}>
      <AnimatedScrollView
        ref={scrollRef}
        style={[StyleSheet.absoluteFill, styles.scroll]}
        contentContainerStyle={contentStyle}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
        testID="git-diff-scroll"
      >
        <NativeCanvasSlabLayer
          model={model}
          viewportHeight={viewport.height}
          scrollTop={scrollTop}
          textLayout={textLayout}
          paints={paints}
          horizontalOffsets={horizontalOffsets}
        />
        {interactionFiles.map((file) => (
          <NativeCanvasFileHeader
            key={`${file.path}:header`}
            file={file}
            viewportWidth={model.viewportWidth}
            scrollTop={scrollTop}
            textLayout={headerTextLayout}
            paints={paints}
            headerSurface={props.palette.headerSurface}
            headerActiveSurface={props.palette.headerActiveSurface}
            selectedPath={props.selectedPath}
            mode={props.mode}
            onToggleFile={props.onToggleFile}
            onSelectPath={props.onSelectPath}
          />
        ))}
        {interactionFiles.map((file) => (
          <NativeFileBody
            key={`${file.path}:body`}
            file={file}
            model={model}
            mode={props.mode}
            horizontalOffsets={horizontalOffsets}
          />
        ))}
        <NativeReviewOverlays model={model} mode={props.mode} />
        <Animated.View pointerEvents="none" style={keyboardSpacerStyle} />
      </AnimatedScrollView>
    </View>
  );
}

function NativeCanvasSlabLayer({
  model,
  viewportHeight,
  scrollTop,
  textLayout,
  paints,
  horizontalOffsets,
}: {
  model: DiffDocumentModel;
  viewportHeight: number;
  scrollTop: SharedValue<number>;
  textLayout: NativeTextLayout;
  paints: NativePaints;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const [windowTop, setWindowTop] = useState(0);
  const updateWindow = useCallback((nextTop: number) => {
    setWindowTop((current) => (current === nextTop ? current : nextTop));
  }, []);
  useAnimatedReaction(
    () => nativeCanvasWindowBucket(scrollTop.value, viewportHeight),
    (bucket, previous) => {
      if (bucket !== previous) {
        scheduleOnRN(updateWindow, nativeCanvasWindowTop(bucket, viewportHeight));
      }
    },
    [updateWindow, viewportHeight],
  );
  const descriptors = useMemo(
    () => buildNativeCanvasSlabs(model, viewportHeight),
    [model, viewportHeight],
  );
  const visible = useMemo(
    () => nativeCanvasSlabsForViewport(descriptors, windowTop, viewportHeight),
    [descriptors, viewportHeight, windowTop],
  );
  if (model.viewportWidth <= 0 || viewportHeight <= 0) return null;
  return visible.map((slab) => (
    <NativeCanvasSlabView
      key={slab.key}
      slab={slab}
      model={model}
      textLayout={textLayout}
      paints={paints}
      horizontalOffsets={horizontalOffsets}
    />
  ));
}

function NativeCanvasFileHeader({
  file,
  viewportWidth,
  scrollTop,
  textLayout,
  paints,
  headerSurface,
  headerActiveSurface,
  selectedPath,
  mode,
  onToggleFile,
  onSelectPath,
}: {
  file: DiffFileSection;
  viewportWidth: number;
  scrollTop: SharedValue<number>;
  textLayout: NativeHeaderTextLayout;
  paints: NativePaints;
  headerSurface: string;
  headerActiveSurface: string;
  selectedPath: DiffSurfaceProps["selectedPath"];
  mode: DiffSurfaceProps["mode"];
  onToggleFile: DiffSurfaceProps["onToggleFile"];
  onSelectPath: DiffSurfaceProps["onSelectPath"];
}) {
  const [active, setActive] = useState(false);
  const picture = useMemo(
    () => recordNativeHeaderPicture({ file, viewportWidth, textLayout, paints }),
    [file, paints, textLayout, viewportWidth],
  );
  const { top, bottom, headerHeight } = file;
  const stickyStyle = useAnimatedStyle(() => {
    const pinOffset = Math.max(0, scrollTop.value - top);
    const maximumPinOffset = Math.max(0, bottom - headerHeight - top);
    return { transform: [{ translateY: Math.min(pinOffset, maximumPinOffset) }] };
  }, [bottom, headerHeight, top, scrollTop]);
  const style = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: file.top,
      left: 0,
      width: viewportWidth,
      height: file.headerHeight,
      backgroundColor: active ? headerActiveSurface : headerSurface,
      zIndex: 5,
      elevation: 2,
    }),
    [active, file.headerHeight, file.top, headerActiveSurface, headerSurface, viewportWidth],
  );
  return (
    <Animated.View style={[style, stickyStyle]}>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Picture picture={picture} />
      </Canvas>
      <DocumentFileHeader
        file={file}
        selectedPath={selectedPath}
        mode={mode}
        onToggleFile={onToggleFile}
        onSelectPath={onSelectPath}
        canvasRendered
        onActiveChange={setActive}
      />
    </Animated.View>
  );
}

function NativeFileBody({
  file,
  model,
  mode,
  horizontalOffsets,
}: {
  file: DiffFileSection;
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const touchRef = useRef<{ x: number; y: number; startedAt: number; moved: boolean } | null>(null);
  const reviewActions = mode.kind === "working" ? mode.reviewActions : undefined;
  const touchStart = useCallback((event: GestureResponderEvent) => {
    touchRef.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
      startedAt: Date.now(),
      moved: false,
    };
  }, []);
  const touchMove = useCallback((event: GestureResponderEvent) => {
    const touch = touchRef.current;
    if (
      touch &&
      Math.hypot(event.nativeEvent.pageX - touch.x, event.nativeEvent.pageY - touch.y) > 10
    ) {
      touch.moved = true;
    }
  }, []);
  const touchEnd = useCallback(
    (event: GestureResponderEvent) => {
      const touch = touchRef.current;
      touchRef.current = null;
      if (!touch || touch.moved || Date.now() - touch.startedAt > 500 || !reviewActions) return;
      const hit = hitTestDiffBodyPoint({
        model,
        file,
        locationX: event.nativeEvent.locationX,
        locationY: event.nativeEvent.locationY,
        horizontalOffset: horizontalOffsetForPath(horizontalOffsets.value, file.path),
      });
      if (hit?.kind === "cell" && hit.target) reviewActions.onStartComment(hit.target);
    },
    [file, horizontalOffsets, model, reviewActions],
  );
  return (
    <View
      testID={`diff-file-${file.fileIndex}-body`}
      style={inlineUnistylesStyle<ViewStyle>({
        position: "absolute",
        top: file.bodyTop,
        left: 0,
        right: 0,
        height: file.bodyHeight,
        zIndex: 2,
      })}
      onTouchStart={touchStart}
      onTouchMove={touchMove}
      onTouchEnd={touchEnd}
    >
      {!file.isCollapsed && !model.wrapLines ? (
        <HorizontalScroll file={file} offsets={horizontalOffsets} />
      ) : null}
    </View>
  );
}

function NativeReviewOverlays({
  model,
  mode,
}: {
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
}) {
  if (mode.kind !== "working" || !mode.reviewActions) return null;
  const reviewActions = mode.reviewActions;
  return model.rows.flatMap((row) => {
    if (row.kind !== "line" || row.reviewHeight === 0) return [];
    const columnWidth = model.viewportWidth / row.cells.length;
    return row.cells.flatMap((cell, index) => {
      if (!cell?.reviewTarget) return [];
      const comments = reviewActions.commentsByTarget.get(cell.reviewTarget.key) ?? [];
      const editor = reviewActions.editor;
      const hasEditor =
        editor?.target.filePath === cell.reviewTarget.filePath &&
        editor.target.side === cell.reviewTarget.side &&
        editor.target.lineNumber === cell.reviewTarget.lineNumber;
      if (comments.length === 0 && !hasEditor) return [];
      return [
        <View
          key={cell.reviewTarget.key}
          style={inlineUnistylesStyle<ViewStyle>({
            position: "absolute",
            top: row.top + row.height - row.reviewHeight,
            left: index * columnWidth,
            width: columnWidth,
            height: row.reviewHeight,
            zIndex: 6,
          })}
        >
          <InlineReviewThread
            reviewTarget={cell.reviewTarget}
            reviewActions={reviewActions}
            height={row.reviewHeight}
            viewportWidth={columnWidth}
            pinToViewport={!model.wrapLines}
          />
        </View>,
      ];
    });
  });
}

function NativeCanvasSlabView({
  slab,
  model,
  textLayout,
  paints,
  horizontalOffsets,
}: {
  slab: NativeCanvasSlab;
  model: DiffDocumentModel;
  textLayout: NativeTextLayout;
  paints: NativePaints;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const file = model.files[slab.fileIndex];
  const pictures = useMemo(
    () =>
      recordNativeSlabPictures({
        model,
        fileIndex: slab.fileIndex,
        top: slab.top,
        height: slab.height,
        viewportWidth: model.viewportWidth,
        textLayout,
        paints,
      }),
    [model, paints, slab.fileIndex, slab.height, slab.top, textLayout],
  );
  const style = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: slab.top,
      left: 0,
      right: 0,
      height: slab.height,
      zIndex: 3,
    }),
    [slab.height, slab.top],
  );
  if (!file) return null;
  const unifiedClip = {
    x: file.gutterWidth + CODE_LEFT_PADDING,
    width: model.viewportWidth - file.gutterWidth - CODE_LEFT_PADDING,
  };
  const columnWidth = model.viewportWidth / 2;
  const splitClipWidth = columnWidth - file.gutterWidth - CODE_LEFT_PADDING;
  return (
    <View pointerEvents="none" style={style} testID={`git-diff-canvas-${slab.key}`}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Picture picture={pictures.fixed} />
      </Canvas>
      <NativeSlabCode
        picture={pictures.content.unified}
        path={slab.path}
        horizontalOffsets={horizontalOffsets}
        wrapLines={model.wrapLines}
        clipX={unifiedClip.x}
        clipWidth={unifiedClip.width}
        height={slab.height}
      />
      {model.layout === "split" ? (
        <>
          <NativeSlabCode
            picture={pictures.content.left}
            path={slab.path}
            horizontalOffsets={horizontalOffsets}
            wrapLines={model.wrapLines}
            clipX={file.gutterWidth + CODE_LEFT_PADDING}
            clipWidth={splitClipWidth}
            height={slab.height}
          />
          <NativeSlabCode
            picture={pictures.content.right}
            path={slab.path}
            horizontalOffsets={horizontalOffsets}
            wrapLines={model.wrapLines}
            clipX={columnWidth + file.gutterWidth + CODE_LEFT_PADDING}
            clipWidth={splitClipWidth}
            height={slab.height}
          />
        </>
      ) : null}
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Picture picture={pictures.gutter} />
      </Canvas>
    </View>
  );
}

function NativeSlabCode({
  picture,
  path,
  horizontalOffsets,
  wrapLines,
  clipX,
  clipWidth,
  height,
}: {
  picture: SkPicture;
  path: string;
  horizontalOffsets: SharedValue<DiffHorizontalOffsets>;
  wrapLines: boolean;
  clipX: number;
  clipWidth: number;
  height: number;
}) {
  const pictureTransform = useDerivedValue(() => [
    {
      translateX: -clipX - (wrapLines ? 0 : horizontalOffsetForPath(horizontalOffsets.value, path)),
    },
  ]);
  const clipStyle = useMemo<ViewStyle>(
    () => ({
      position: "absolute",
      top: 0,
      left: clipX,
      width: clipWidth,
      height,
      overflow: "hidden",
    }),
    [clipWidth, clipX, height],
  );
  if (clipWidth <= 0 || height <= 0) return null;
  return (
    <View pointerEvents="none" style={clipStyle}>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Group transform={pictureTransform}>
          <Picture picture={picture} />
        </Group>
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden" },
  scroll: { backgroundColor: "transparent" },
});
