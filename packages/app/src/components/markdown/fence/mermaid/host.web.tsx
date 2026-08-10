import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { Code, Scan, Workflow, ZoomIn, ZoomOut } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { MarkdownFenceRendererProps } from "../types";
import type { MermaidRenderRequest } from "./render-model";
import { mermaidRuntimeHtml } from "./runtime/html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeRenderMessage } from "./runtime/messages";
import { MermaidRuntimeRequestDriver } from "./runtime/request-driver";
import { useMermaidRenderModel } from "./use-render-model";
import { getDiagramBoxStyle } from "./presentation";

interface MermaidFenceHostImplProps extends MarkdownFenceRendererProps {
  colorScheme?: "light" | "dark";
}

interface MermaidIframeRuntimeProps {
  request: MermaidRenderRequest | null;
  height: number;
  onRendered: (message: {
    revision: number;
    source: string;
    colorScheme: "light" | "dark";
    height: number;
    width: number;
  }) => void;
  onRenderFailed: (revision: number) => void;
}

function MermaidIframeRuntime({
  request,
  height,
  onRendered,
  onRenderFailed,
}: MermaidIframeRuntimeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const driverRef = useRef<MermaidRuntimeRequestDriver | null>(null);
  driverRef.current ??= new MermaidRuntimeRequestDriver();
  const iframeStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "block",
      width: "100%",
      height,
      border: 0,
      pointerEvents: "none",
      background: "transparent",
    }),
    [height],
  );

  const sendRequest = useCallback((current: MermaidRenderRequest | null) => {
    const target = iframeRef.current?.contentWindow;
    if (!current || !target) {
      return;
    }
    const message: MermaidRuntimeRenderMessage = {
      type: "render",
      revision: current.revision,
      source: current.source,
      colorScheme: current.colorScheme,
      interactive: false,
    };
    target.postMessage(message, "*");
  }, []);

  useEffect(() => {
    sendRequest(driverRef.current?.update(request) ?? null);
  }, [request, sendRequest]);

  useEffect(() => {
    function receiveMessage(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message) {
        return;
      }
      if (message.type === "bridgeReady") {
        sendRequest(driverRef.current?.ready() ?? null);
        return;
      }
      if (message.type === "renderError") {
        onRenderFailed(message.revision);
        sendRequest(driverRef.current?.settled(message.revision, false) ?? null);
        return;
      }
      onRendered(message);
      sendRequest(driverRef.current?.settled(message.revision, true) ?? null);
    }
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [onRenderFailed, onRendered, sendRequest]);

  return (
    <iframe
      ref={iframeRef}
      title=""
      aria-hidden
      sandbox="allow-scripts"
      srcDoc={mermaidRuntimeHtml}
      tabIndex={-1}
      style={iframeStyle}
    />
  );
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

function MermaidFenceHostImpl({
  code,
  phase,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidFenceHostImplProps) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase,
    colorScheme,
  });
  const [hasRuntimeContent, setHasRuntimeContent] = useState(false);
  const handleRendered = useCallback(
    (message: {
      revision: number;
      source: string;
      colorScheme: "light" | "dark";
      height: number;
      width: number;
    }) => {
      setHasRuntimeContent(true);
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );
  const visible = state.visible;
  const canShowDiagram = visible !== null && hasRuntimeContent;
  const runtimeHeight = Math.max(visible?.height ?? 240, 1);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const controlsRegionRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const applyTransformToElement = useCallback(
    (element: HTMLDivElement, transform: { x: number; y: number; scale: number }) => {
      const { x, y, scale } = transform;
      element.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    },
    [],
  );
  const applyTransform = useCallback(() => {
    if (contentRef.current) {
      applyTransformToElement(contentRef.current, transformRef.current);
    }
  }, [applyTransformToElement]);
  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (node) {
        applyTransformToElement(node, transformRef.current);
      }
    },
    [applyTransformToElement],
  );
  const setControlsRegionRef = useCallback((node: unknown) => {
    controlsRegionRef.current = node instanceof HTMLDivElement ? node : null;
  }, []);
  const hasFocusedControls = useCallback(() => {
    const region = controlsRegionRef.current;
    const active = document.activeElement;
    return Boolean(region && active instanceof Node && region.contains(active));
  }, []);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const handleFocusWithin = useCallback(() => setIsFocusWithin(true), []);
  const handleBlurWithin = useCallback(() => {
    window.requestAnimationFrame(() => setIsFocusWithin(hasFocusedControls()));
  }, [hasFocusedControls]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !visible) {
      return;
    }
    const activeViewport = viewport;
    function zoomWithWheel(event: WheelEvent): void {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const transform = transformRef.current;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * 0.01)));
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
      const rect = activeViewport.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      transform.x = x - ((x - transform.x) / transform.scale) * scale;
      transform.y = y - ((y - transform.y) / transform.scale) * scale;
      transform.scale = scale;
      applyTransform();
    }
    viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", zoomWithWheel);
  }, [applyTransform, visible]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType !== "mouse") {
      return;
    }
    const transform = transformRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      transformRef.current.x = drag.originX + event.clientX - drag.startX;
      transformRef.current.y = drag.originY + event.clientY - drag.startY;
      applyTransform();
    },
    [applyTransform],
  );
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);
  const resetTransform = useCallback(() => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }, [applyTransform]);
  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const x = rect.width / 2;
      const y = rect.height / 2;
      const transform = transformRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
      transform.x = x - ((x - transform.x) / transform.scale) * scale;
      transform.y = y - ((y - transform.y) / transform.scale) * scale;
      transform.scale = scale;
      applyTransform();
    },
    [applyTransform],
  );
  const zoomInPress = useCallback(() => zoomBy(1.25), [zoomBy]);
  const zoomOutPress = useCallback(() => zoomBy(0.8), [zoomBy]);

  const [showSource, setShowSource] = useState(false);
  const showSourcePress = useCallback(() => setShowSource(true), []);
  const showDiagramPress = useCallback(() => setShowSource(false), []);
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const isCompact = useIsCompactFormFactor();
  const controlsVisible = isHovered || isCompact || isFocusWithin;

  useEffect(() => {
    if (!showSource && contentRef.current) {
      applyTransformToElement(contentRef.current, transformRef.current);
    }
  }, [applyTransformToElement, showSource]);

  const sourceView = useMemo(() => {
    const { marginTop, marginBottom, marginVertical, ...sourceTextStyle } = textStyle;
    const margins: ViewStyle = {
      marginTop: marginTop ?? marginVertical,
      marginBottom: marginBottom ?? marginVertical,
    };
    const text: TextStyle = sourceTextStyle;
    return {
      container: [margins, sourceContainerStyle],
      text,
    };
  }, [textStyle]);
  const diagramBoxStyle = getDiagramBoxStyle(textStyle);

  const diagramVisible = canShowDiagram && !showSource;
  const sourceVisible = !canShowDiagram || showSource;
  let rootStyle: StyleProp<ViewStyle> = sourceContainerStyle;
  if (diagramVisible) {
    rootStyle = [diagramBoxStyle, containerStyle];
  } else if (showSource) {
    rootStyle = sourceView.container;
  }
  const sourceTextStyle = showSource ? sourceView.text : textStyle;

  const runtime = (
    <MermaidIframeRuntime
      request={request}
      height={runtimeHeight}
      onRendered={handleRendered}
      onRenderFailed={renderFailed}
    />
  );
  return (
    <View
      ref={setControlsRegionRef}
      style={rootStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocusWithin}
      onBlur={handleBlurWithin}
    >
      {sourceVisible ? (
        <HighlightedCodeBlock
          code={code}
          language="mermaid"
          inheritedStyles={inheritedStyles}
          textStyle={sourceTextStyle}
        />
      ) : null}
      <div
        ref={viewportRef}
        role={diagramVisible ? "img" : undefined}
        aria-label={diagramVisible ? t("message.diagram.diagram") : undefined}
        aria-hidden={!diagramVisible}
        style={diagramVisible ? viewportDomStyle : measuringRuntimeStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={resetTransform}
      >
        <div ref={setContentRef} style={contentDomStyle}>
          {runtime}
        </div>
      </div>
      {diagramVisible ? (
        <View style={controlStyles.cluster}>
          <DiagramControlButton
            icon={ZoomIn}
            label={t("message.diagram.zoomIn")}
            onPress={zoomInPress}
            visible={controlsVisible}
          />
          <DiagramControlButton
            icon={ZoomOut}
            label={t("message.diagram.zoomOut")}
            onPress={zoomOutPress}
            visible={controlsVisible}
          />
          <DiagramControlButton
            icon={Scan}
            label={t("message.diagram.resetZoom")}
            onPress={resetTransform}
            visible={controlsVisible}
          />
          <DiagramControlButton
            icon={Code}
            label={t("message.diagram.viewSource")}
            onPress={showSourcePress}
            visible={controlsVisible}
          />
        </View>
      ) : null}
      {showSource && canShowDiagram ? (
        <View style={[controlStyles.cluster, controlStyles.clusterSourceOffset]}>
          <DiagramControlButton
            icon={Workflow}
            label={t("message.diagram.viewDiagram")}
            onPress={showDiagramPress}
            visible={controlsVisible}
            plain
          />
        </View>
      ) : null}
    </View>
  );
}

interface DiagramControlButtonProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  visible: boolean;
  plain?: boolean;
}

const DiagramControlButton = React.memo(function DiagramControlButton({
  icon: Icon,
  label,
  onPress,
  visible,
  plain = false,
}: DiagramControlButtonProps) {
  const pillStyle = visible ? controlStyles.button : controlStyles.buttonHidden;
  const plainStyle = visible ? controlStyles.plainButton : controlStyles.plainButtonHidden;
  return (
    <Pressable
      onPress={onPress}
      style={plain ? plainStyle : pillStyle}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
    >
      {({ hovered }) => (
        <Icon
          size={14}
          color={hovered ? controlStyles.iconHovered.color : controlStyles.icon.color}
        />
      )}
    </Pressable>
  );
});

const controlStyles = StyleSheet.create((theme) => ({
  cluster: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  clusterSourceOffset: { right: 40 },
  button: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: 1,
    pointerEvents: "auto",
  },
  buttonHidden: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: 0,
    pointerEvents: "none",
  },
  plainButton: { padding: theme.spacing[1], opacity: 1, pointerEvents: "auto" },
  plainButtonHidden: { padding: theme.spacing[1], opacity: 0, pointerEvents: "none" },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
}));

const sourceContainerStyle: ViewStyle = { position: "relative" };
const containerStyle: ViewStyle = { overflow: "hidden", position: "relative" };
const viewportDomStyle: React.CSSProperties = { cursor: "grab", userSelect: "none" };
const contentDomStyle: React.CSSProperties = { transformOrigin: "0 0" };
const measuringRuntimeStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  opacity: 0,
  pointerEvents: "none",
  overflow: "hidden",
};
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const ThemedMermaidFenceHost = withUnistyles(MermaidFenceHostImpl);

export function MermaidFenceHost(props: MarkdownFenceRendererProps) {
  return <ThemedMermaidFenceHost {...props} uniProps={mapColorScheme} />;
}
