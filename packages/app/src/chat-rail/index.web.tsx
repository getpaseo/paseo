import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  CHAT_OUTLINE_GUTTER_INSET,
  CHAT_OUTLINE_MIN_PANEL_WIDTH,
} from "@/agent-stream/chat-outline/geometry";
import { resolveContentMaxWidth, useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { CHAT_COLUMN_BASE_GUTTER, resolveChatColumnGutters } from "./gutters";
import type { ChatColumnRailSurfaceProps } from "./index";

export type { ChatColumnRailSurfaceProps };

const STYLE_ID = "paseo-chat-column-rail";
// React Native Web turns `dataSet={{ chatRailLane: "true" }}` into `data-chat-rail-lane="true"`.
// When the enclosing pane reserves an outline gutter, every tagged rail consumer receives
// the same horizontal gutters in the browser's layout pass without re-rendering React subtrees
// or growing Unistyles' CSS registry.
const RAIL_RULE =
  '[data-chat-rail-active="true"] [data-chat-rail-lane="true"]{padding-left:var(--paseo-chat-rail-left)!important;padding-right:var(--paseo-chat-rail-right)!important;}';

const BASE_SURFACE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
};

const ChatOutlineInsetContext = createContext(0);

export const CHAT_COLUMN_RAIL_DATASET: Record<string, string> | undefined = Object.freeze({
  chatRailLane: "true",
});

function ensureChatColumnRailStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = RAIL_RULE;
  document.head.appendChild(style);
}

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

/**
 * Pane-level owner of the chat column rail on web.
 *
 * Measures the pane width once against `CHAT_OUTLINE_MIN_PANEL_WIDTH` (ignoring 0px
 * measurements from hidden retained tabs) and publishes the resolved horizontal gutters
 * via CSS custom properties to the composer, track bar, and callouts. Only the boolean
 * inset value (`0` or `44`) enters React context for `AgentStreamView`.
 */
export function ChatColumnRailSurface({ serverId, children }: ChatColumnRailSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [isBelow, setIsBelow] = useState(true);
  const chatOutlineEnabled = useSettings((settings) => settings.chatOutlineEnabled);
  const contentMaxWidth = useSettings(resolveContentMaxWidth);
  const supportsChatOutline = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentTimelinePromptIndex === true,
  );

  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const update = (width: number) => {
      // Retained inactive tabs sit under `display: none` and report 0; ignore them.
      if (width <= 0) return;
      const next = width < CHAT_OUTLINE_MIN_PANEL_WIDTH;
      setIsBelow((current) => (current === next ? current : next));
    };
    update(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width =
        entries[entries.length - 1]?.contentRect.width ?? node.getBoundingClientRect().width;
      update(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const outlineInset =
    supportsChatOutline && chatOutlineEnabled && !isBelow ? CHAT_OUTLINE_GUTTER_INSET : 0;

  useLayoutEffect(() => {
    if (outlineInset > 0) {
      ensureChatColumnRailStyle();
    }
  }, [outlineInset]);

  const surfaceStyle = useMemo((): CSSProperties => {
    if (outlineInset === 0) {
      return BASE_SURFACE_STYLE;
    }
    const gutters = resolveChatColumnGutters({
      gutter: CHAT_COLUMN_BASE_GUTTER,
      outlineInset,
      contentMaxWidth,
    });
    return {
      ...BASE_SURFACE_STYLE,
      "--paseo-chat-rail-left": cssLength(gutters.paddingLeft),
      "--paseo-chat-rail-right": cssLength(gutters.paddingRight),
    } as CSSProperties;
  }, [contentMaxWidth, outlineInset]);

  return (
    <ChatOutlineInsetContext.Provider value={outlineInset}>
      <div
        ref={surfaceRef}
        style={surfaceStyle}
        data-chat-rail-active={outlineInset > 0 ? "true" : undefined}
      >
        {children}
      </div>
    </ChatOutlineInsetContext.Provider>
  );
}

export function useChatOutlineInset(): number {
  return useContext(ChatOutlineInsetContext);
}
