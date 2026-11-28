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
import type { ChatColumnRailSurfaceProps, ChatOutlineRailState } from "./index";

export type { ChatColumnRailSurfaceProps, ChatOutlineRailState };

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

const DISABLED_CHAT_OUTLINE_RAIL: ChatOutlineRailState = Object.freeze({
  enabled: false,
  inset: 0,
});

const ChatOutlineRailContext = createContext<ChatOutlineRailState>(DISABLED_CHAT_OUTLINE_RAIL);

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
 * via CSS custom properties to the composer, track bar, and callouts. Only the outline
 * enabled flag and reserved inset (`0` or `44`) enter React context for `AgentStreamView`.
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

  const enabled = supportsChatOutline && chatOutlineEnabled;
  const inset = enabled && !isBelow ? CHAT_OUTLINE_GUTTER_INSET : 0;

  useLayoutEffect(() => {
    if (inset > 0) {
      ensureChatColumnRailStyle();
    }
  }, [inset]);

  const outlineRail = useMemo<ChatOutlineRailState>(
    () => (enabled ? { enabled, inset } : DISABLED_CHAT_OUTLINE_RAIL),
    [enabled, inset],
  );

  const surfaceStyle = useMemo((): CSSProperties => {
    if (inset === 0) {
      return BASE_SURFACE_STYLE;
    }
    const gutters = resolveChatColumnGutters({
      gutter: CHAT_COLUMN_BASE_GUTTER,
      outlineInset: inset,
      contentMaxWidth,
    });
    return {
      ...BASE_SURFACE_STYLE,
      "--paseo-chat-rail-left": cssLength(gutters.paddingLeft),
      "--paseo-chat-rail-right": cssLength(gutters.paddingRight),
    } as CSSProperties;
  }, [contentMaxWidth, inset]);

  return (
    <ChatOutlineRailContext.Provider value={outlineRail}>
      <div
        ref={surfaceRef}
        style={surfaceStyle}
        data-chat-rail-active={inset > 0 ? "true" : undefined}
      >
        {children}
      </div>
    </ChatOutlineRailContext.Provider>
  );
}

export function useChatOutlineRail(): ChatOutlineRailState {
  return useContext(ChatOutlineRailContext);
}
