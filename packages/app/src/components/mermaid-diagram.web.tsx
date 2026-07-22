import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Pressable, View, type TextStyle, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { Code, Scan, Workflow, ZoomIn, ZoomOut } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { containsUnsafeMermaidSource } from "@/utils/mermaid-fence";

export interface MermaidDiagramProps {
  code: string;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

interface MermaidDiagramImplProps extends MermaidDiagramProps {
  colorScheme?: "light" | "dark";
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

// mermaid.initialize()/render() mutate shared global parser, database, and
// theme state; two concurrent renders can interleave and draw with each
// other's config. All renders are serialized through this chain. Tasks never
// reject (each catches internally).
let renderChain: Promise<void> = Promise.resolve();

function enqueueMermaidRender(task: () => Promise<void>): void {
  renderChain = renderChain.then(task);
}

async function renderMermaid(code: string, colorScheme: "light" | "dark", id: string) {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: colorScheme === "dark" ? "dark" : "default",
    // Extends mermaid's default secure list (which does NOT include theme
    // keys) so %%{init}%% directives can't override app theming or inject
    // CSS fetch paths via themeCSS.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "theme",
      "themeVariables",
      "themeCSS",
    ],
    // HTML labels are inserted into the live DOM during layout, before
    // sanitization — keep labels on the plain-SVG path.
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  });
  const { svg } = await mermaid.render(id, code);
  return svg;
}

// Rendered SVGs keyed by scheme + source so virtualization unmount/remount
// cycles don't re-run mermaid layout. Insertion-order eviction; entries are
// just strings, so the cap is generous.
const svgCache = new Map<string, string>();
const SVG_CACHE_LIMIT = 50;

function svgCacheKey(code: string, colorScheme: string): string {
  return `${colorScheme}\u0000${code}`;
}

function svgCachePut(key: string, svg: string): void {
  if (svgCache.size >= SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, svg);
}

let nextDiagramId = 0;

function MermaidDiagramImpl({
  code,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidDiagramImplProps) {
  const { t } = useTranslation();
  // Last successfully rendered SVG. Stays put while a streaming (and therefore
  // temporarily invalid) diagram catches up; null until the first valid parse.
  // ponytail: if the streamed prefix changes within the first 32 chars the
  // parent block key remounts us and a previously rendered prefix briefly
  // falls back to the code block; stable block keys in message.tsx would fix
  // the flicker if it ever bothers anyone.
  const [svg, setSvg] = useState<string | null>(
    () => svgCache.get(svgCacheKey(code, colorScheme)) ?? null,
  );
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    nextDiagramId += 1;
    idRef.current = `paseo-mermaid-${nextDiagramId}`;
  }
  const renderSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      // Invalidate any queued render task for this component.
      renderSeqRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    renderSeqRef.current += 1;
    const seq = renderSeqRef.current;
    if (containsUnsafeMermaidSource(code)) {
      // A previously rendered safe prefix must not mask unsafe final source.
      setSvg(null);
      return;
    }
    const cacheKey = svgCacheKey(code, colorScheme);
    const cached = svgCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      return;
    }
    enqueueMermaidRender(async () => {
      // Superseded while queued (newer chunk arrived or unmounted) — skip so
      // a token-by-token stream costs at most one in-flight layout, not one
      // per chunk.
      if (renderSeqRef.current !== seq) return;
      try {
        const rendered = await renderMermaid(code, colorScheme, `${idRef.current}-${seq}`);
        svgCachePut(cacheKey, rendered);
        if (mountedRef.current && renderSeqRef.current === seq) setSvg(rendered);
      } catch {
        // Invalid or still-streaming diagram source — keep the previous render.
      }
    });
  }, [code, colorScheme]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const applyTransform = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const { x, y, scale } = transformRef.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  useEffect(() => {
    applyTransform();
  }, [svg, applyTransform]);

  // Zoom on ctrl/cmd+wheel (trackpad pinch arrives as ctrl+wheel); plain wheel
  // keeps scrolling the chat. Attached natively because React's root wheel
  // listener is passive, so preventDefault would be ignored in onWheel.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const transform = transformRef.current;
      // Per-event factor clamp: trackpad pinches stream small deltas, but a
      // single mouse-wheel notch is ~120 and exp(1.2) would triple the scale
      // in one click.
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * 0.01)));
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      // Keep the point under the cursor fixed while scaling.
      transform.x = px - ((px - transform.x) / transform.scale) * scale;
      transform.y = py - ((py - transform.y) / transform.scale) * scale;
      transform.scale = scale;
      applyTransform();
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [svg, applyTransform]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // ponytail: mouse-only pan; touchscreen pinch/pan can come via a WebView
    // or gesture-handler pass if mobile-web users ask.
    if (event.button !== 0 || event.pointerType !== "mouse") return;
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
      if (!drag || event.pointerId !== drag.pointerId) return;
      const transform = transformRef.current;
      transform.x = drag.originX + (event.clientX - drag.startX);
      transform.y = drag.originY + (event.clientY - drag.startY);
      applyTransform();
    },
    [applyTransform],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  const resetTransform = useCallback(() => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    applyTransform();
  }, [applyTransform]);

  // Button zoom is anchored to the viewport center, mirroring the wheel math.
  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const px = rect.width / 2;
      const py = rect.height / 2;
      const transform = transformRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
      transform.x = px - ((px - transform.x) / transform.scale) * scale;
      transform.y = py - ((py - transform.y) / transform.scale) * scale;
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
  const controlsVisible = isHovered || isCompact;

  const svgHtml = useMemo(() => ({ __html: svg ?? "" }), [svg]);

  // Source view hoists the fence margins onto the wrapper so the floating
  // view-diagram toggle aligns with the code block's own copy button — both
  // sit spacing[2] below the same visible box edge.
  const sourceView = useMemo(() => {
    const { marginTop, marginBottom, marginVertical, ...text } = textStyle;
    return {
      container: [
        {
          marginTop: marginTop ?? marginVertical,
          marginBottom: marginBottom ?? marginVertical,
        } as ViewStyle,
        sourceContainerStyle,
      ],
      text: text as TextStyle,
    };
  }, [textStyle]);

  if (!svg) {
    return (
      <HighlightedCodeBlock
        code={code}
        language="mermaid"
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    );
  }

  if (showSource) {
    return (
      <View
        style={sourceView.container}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <HighlightedCodeBlock
          code={code}
          language="mermaid"
          inheritedStyles={inheritedStyles}
          textStyle={sourceView.text}
        />
        {/* Sits left of the code block's copy button, matching its plain style. */}
        <View style={[controlStyles.cluster, controlStyles.clusterSourceOffset]}>
          <MermaidControlButton
            icon={Workflow}
            label={t("message.mermaid.viewDiagram")}
            onPress={showDiagramPress}
            visible={controlsVisible}
            plain
          />
        </View>
      </View>
    );
  }

  const { fontFamily: _ff, fontSize: _fs, color: _c, lineHeight: _lh, ...boxStyle } = textStyle;
  return (
    <View
      style={[boxStyle as ViewStyle, containerStyle]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <div
        ref={viewportRef}
        role="img"
        aria-label={t("message.mermaid.diagram")}
        style={viewportDomStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={resetTransform}
      >
        <div
          ref={contentRef}
          style={contentDomStyle}
          // securityLevel "strict" sanitizes the SVG mermaid produces, and
          // resource-bearing source is rejected before render (see
          // UNSAFE_MERMAID_SOURCE).
          dangerouslySetInnerHTML={svgHtml}
        />
      </div>
      <View style={controlStyles.cluster}>
        <MermaidControlButton
          icon={ZoomIn}
          label={t("message.mermaid.zoomIn")}
          onPress={zoomInPress}
          visible={controlsVisible}
        />
        <MermaidControlButton
          icon={ZoomOut}
          label={t("message.mermaid.zoomOut")}
          onPress={zoomOutPress}
          visible={controlsVisible}
        />
        <MermaidControlButton
          icon={Scan}
          label={t("message.mermaid.resetZoom")}
          onPress={resetTransform}
          visible={controlsVisible}
        />
        <MermaidControlButton
          icon={Code}
          label={t("message.mermaid.viewSource")}
          onPress={showSourcePress}
          visible={controlsVisible}
        />
      </View>
    </View>
  );
}

interface MermaidControlButtonProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  visible: boolean;
  /** Borderless, matching HighlightedCodeBlock's copy button. */
  plain?: boolean;
}

const MermaidControlButton = React.memo(function MermaidControlButton({
  icon: Icon,
  label,
  onPress,
  visible,
  plain = false,
}: MermaidControlButtonProps) {
  const pillStyle = visible ? controlStyles.button : controlStyles.buttonHidden;
  const plainStyle = visible ? controlStyles.plainButton : controlStyles.plainButtonHidden;
  const style = plain ? plainStyle : pillStyle;
  return (
    <Pressable
      onPress={onPress}
      style={style}
      pointerEvents={visible ? "auto" : "none"}
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
  clusterSourceOffset: {
    // Leave room for HighlightedCodeBlock's own copy button.
    right: 40,
  },
  button: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: 1,
  },
  buttonHidden: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: 0,
  },
  plainButton: {
    padding: theme.spacing[1],
    opacity: 1,
  },
  plainButtonHidden: {
    padding: theme.spacing[1],
    opacity: 0,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  iconHovered: {
    color: theme.colors.foreground,
  },
}));

const sourceContainerStyle: ViewStyle = { position: "relative" };

const containerStyle: ViewStyle = { overflow: "hidden" };

const viewportDomStyle: React.CSSProperties = {
  cursor: "grab",
  userSelect: "none",
};

const contentDomStyle: React.CSSProperties = {
  transformOrigin: "0 0",
};

const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });

const ThemedMermaidDiagramImpl = withUnistyles(MermaidDiagramImpl);

export function MermaidDiagram(props: MermaidDiagramProps) {
  return <ThemedMermaidDiagramImpl {...props} uniProps={mapColorScheme} />;
}
