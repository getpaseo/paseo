import "@livekit/components-styles";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  Expand,
  Shrink,
  Pencil,
  Trash2,
  MessageSquare,
  MicOff,
  Mic,
  Video,
  VideoOff,
  Monitor,
} from "lucide-react-native";
import {
  LiveKitRoom,
  useParticipants,
  useTracks,
  TrackRefContext,
  TrackToggle,
  RoomAudioRenderer,
  VideoTrack,
  useIsMuted,
  useIsSpeaking,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { sendSessionChat, useSessionChatMessages } from "@/stores/session-chat-store";
import { Track } from "livekit-client";
import { useSharedSessionStore } from "@/stores/shared-session-store";
import { getSharedMediaPreferences } from "@/stores/shared-media-preferences";
import {
  DRAW_PALETTE,
  requestDrawClear,
  setDrawActive,
  setDrawColor,
  useSharedDrawState,
} from "@/stores/shared-draw-store";
import { Fonts } from "@/constants/theme";
import { rectsIntersect, useBrowserRects } from "@/stores/browser-bounds-store";

const PANEL_FONT_FAMILY =
  (Fonts as { sans?: string } | undefined)?.sans ??
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

import { resolveAuthServerUrl } from "@/utils/auth-server-url";

function getAuthServerUrl(): string {
  return resolveAuthServerUrl();
}

interface FloatingVideoPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function FloatingVideoPanel({ visible }: FloatingVideoPanelProps) {
  const { shareToken, sessionToken, room: colyseusRoom } = useSharedSessionStore();
  const [creds, setCreds] = useState<{ token: string; wsUrl: string } | null>(null);

  useEffect(() => {
    if (!shareToken || !sessionToken) return;
    let cancelled = false;
    (async () => {
      const url = `${getAuthServerUrl()}/api/livekit/token?room=${encodeURIComponent(shareToken)}`;
      const res = await fetch(url, {
        credentials: "include",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { token: string; wsUrl: string };
      if (!cancelled) setCreds(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken, sessionToken]);

  if (!visible || !creds || typeof document === "undefined") return null;

  // Prefs come from the PreJoinModal that gated the join flow.
  const prefs = getSharedMediaPreferences();
  const video = prefs.videoEnabled && { deviceId: prefs.videoDeviceId ?? undefined };
  const audio = prefs.audioEnabled && { deviceId: prefs.audioDeviceId ?? undefined };

  return createPortal(
    <LiveKitRoom
      serverUrl={creds.wsUrl}
      token={creds.token}
      video={video}
      audio={audio}
      connect
      data-lk-theme="default"
      style={{ position: "fixed", zIndex: 9999 }}
    >
      <PanelShell roomSend={(t, p) => colyseusRoom?.send?.(t, p)} />
      <RoomAudioRenderer />
    </LiveKitRoom>,
    document.body,
  );
}

function PanelShell({ roomSend }: { roomSend: (type: string, payload?: unknown) => void }) {
  const [minimized, setMinimized] = useState(false);
  // null = auto-size from content; object = user-dragged dimensions. Expand
  // button snaps to a "large" preset; resize handle takes over from there.
  const [customSize, setCustomSize] = useState<{ w: number; h: number } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const expanded = customSize !== null;
  const resizeRef = useRef({ startX: 0, startY: 0, startW: 0, startH: 0, dragging: false });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({
    x: window.innerWidth - 360,
    y: window.innerHeight - 340,
  });
  const dragRef = useRef({ startX: 0, startY: 0, isDragging: false });
  const participants = useParticipants();
  const count = participants.length;
  const browserRects = useBrowserRects();

  // Auto-reposition when a browser WebContentsView overlaps the panel.
  // The native overlay always renders above DOM regardless of z-index,
  // so keeping the panel off the browser rect is the only way to keep
  // it visible. We only snap when we actually overlap — normal drags
  // stay wherever the user put them.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rects = Object.values(browserRects);
    if (rects.length === 0) return;
    const r = el.getBoundingClientRect();
    const panelRect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const overlaps = (pr: { x: number; y: number; width: number; height: number }) =>
      rects.some((b) => rectsIntersect(pr, b));
    if (!overlaps(panelRect)) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const M = 16;
    const candidates = [
      { x: M, y: H - r.height - M },
      { x: W - r.width - M, y: M },
      { x: M, y: M },
      { x: W - r.width - M, y: H - r.height - M },
    ];
    for (const c of candidates) {
      if (!overlaps({ x: c.x, y: c.y, width: r.width, height: r.height })) {
        setPosition(c);
        return;
      }
    }
    setPosition(candidates[1]!);
  }, [browserRects, minimized, customSize]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX - position.x,
      startY: e.clientY - position.y,
      isDragging: true,
    };
  };
  useEffect(() => {
    let rafId = 0;
    let pending: { x: number; y: number } | null = null;
    const flush = () => {
      rafId = 0;
      if (pending) {
        setPosition(pending);
        pending = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.isDragging) return;
      pending = { x: e.clientX - dragRef.current.startX, y: e.clientY - dragRef.current.startY };
      if (!rafId) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      dragRef.current.isDragging = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : 3;
  const baseTile = cols === 1 ? 260 : cols === 2 ? 200 : 160;
  const tileSize = baseTile;
  const autoWidth = cols * tileSize + (cols - 1) * 8 + 12;
  const panelWidth = minimized ? 260 : (customSize?.w ?? autoWidth);
  const panelHeightStyle: React.CSSProperties = minimized
    ? {}
    : customSize
      ? { height: customSize.h }
      : {};

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const w = customSize?.w ?? autoWidth;
    const h = customSize?.h ?? 400;
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: w,
      startH: h,
      dragging: true,
    };
    // Mutate the DOM directly during drag — React re-renders cause LiveKit
    // tiles to relayout, which visibly lags. Commit to state only on mouseup.
    let lastW = w;
    let lastH = h;
    const el = panelRef.current;
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current.dragging) return;
      const dw = ev.clientX - resizeRef.current.startX;
      const dh = ev.clientY - resizeRef.current.startY;
      lastW = Math.max(280, resizeRef.current.startW + dw);
      lastH = Math.max(260, resizeRef.current.startH + dh);
      if (el) {
        el.style.width = `${lastW}px`;
        el.style.height = `${lastH}px`;
      }
    };
    const onUp = () => {
      resizeRef.current.dragging = false;
      setCustomSize({ w: lastW, h: lastH });
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <style>{PANEL_CSS}</style>
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          left: position.x,
          top: position.y,
          width: panelWidth,
          ...panelHeightStyle,
          borderRadius: minimized ? 9999 : 12,
          overflow: "hidden",
          backgroundColor: minimized ? "rgba(49,39,52,0.92)" : "rgba(15,15,17,0.95)",
          backdropFilter: "blur(14px) saturate(130%)",
          WebkitBackdropFilter: "blur(14px) saturate(130%)",
          border: minimized
            ? "1px solid rgba(196,25,139,0.28)"
            : "1px solid rgba(255,255,255,0.06)",
          boxShadow: minimized
            ? "0 6px 24px rgba(196,25,139,0.22), 0 2px 8px rgba(0,0,0,0.4)"
            : "0 12px 40px rgba(0,0,0,0.55)",
          fontFamily: PANEL_FONT_FAMILY,
          display: "flex",
          flexDirection: "column",
          transition: "border-radius 140ms ease, width 140ms ease",
        }}
      >
        <div
          onMouseDown={onMouseDown}
          style={{
            display: "flex",
            alignItems: "center",
            gap: minimized ? 10 : 8,
            padding: minimized ? "6px 10px 6px 16px" : "8px 12px",
            cursor: "grab",
            borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.06)",
            userSelect: "none",
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: "#d4d4d8",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {count} participant{count === 1 ? "" : "s"}
          </span>
          {minimized && (
            <div
              style={{ display: "flex", gap: 6, marginRight: 4 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <MicToggle compact />
              <DrawControls roomSend={roomSend} compact />
            </div>
          )}
          {!minimized && (
            <button
              onClick={() => {
                if (expanded) setCustomSize(null);
                else setCustomSize({ w: autoWidth * 2, h: 500 });
              }}
              style={iconBtnStyle}
              aria-label={expanded ? "Shrink" : "Enlarge"}
              title={expanded ? "Shrink" : "Enlarge — then drag the corner to resize"}
            >
              {expanded ? (
                <Shrink size={14} color="#a1a1aa" />
              ) : (
                <Expand size={14} color="#a1a1aa" />
              )}
            </button>
          )}
          <button
            onClick={() => setMinimized(!minimized)}
            style={iconBtnStyle}
            aria-label={minimized ? "Restore" : "Collapse"}
            title={minimized ? "Restore" : "Collapse"}
          >
            {minimized ? (
              <ChevronDown size={14} color="#a1a1aa" />
            ) : (
              <ChevronUp size={14} color="#a1a1aa" />
            )}
          </button>
        </div>

        {!minimized && (
          <>
            <div
              style={{
                ...(expanded ? { flex: 1, minHeight: 0 } : {}),
                display: "flex",
                overflow: "hidden",
                paddingBottom: expanded ? 12 : 0,
                backgroundColor: "#09090b",
              }}
            >
              <ParticipantGrid
                cols={cols}
                expanded={expanded}
                fillHeight={expanded}
                tileSize={tileSize}
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: "10px",
                backgroundColor: "rgba(24,24,27,0.6)",
                borderTop: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              <MicToggle />
              <CamToggle />
              <TrackToggle
                source={Track.Source.ScreenShare}
                className="hc-control"
                showIcon={false}
              >
                <Monitor size={16} color="#fafafa" />
              </TrackToggle>
              <DrawControls roomSend={roomSend} disabled={expanded} />
              <button
                onClick={() => setChatOpen((o) => !o)}
                className={`hc-control${chatOpen ? " hc-active" : ""}`}
                aria-label={chatOpen ? "Close chat" : "Open chat"}
              >
                <MessageSquare size={16} color="#fafafa" />
              </button>
            </div>
          </>
        )}
        {!minimized && (
          <div
            onMouseDown={startResize}
            title="Drag to resize"
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 18,
              height: 18,
              cursor: "nwse-resize",
              background:
                "linear-gradient(135deg, transparent 0 50%, rgba(255,255,255,0.2) 50% 60%, transparent 60% 70%, rgba(255,255,255,0.2) 70% 80%, transparent 80%)",
            }}
          />
        )}
      </div>
      {chatOpen && !minimized && (
        <div
          style={{
            position: "fixed",
            left: position.x - 320 - 8,
            top: position.y,
            width: 320,
            height: 440,
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: "rgba(15,15,17,0.72)",
            backdropFilter: "blur(18px) saturate(140%)",
            WebkitBackdropFilter: "blur(18px) saturate(140%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
            display: "flex",
            flexDirection: "column",
            fontFamily: PANEL_FONT_FAMILY,
          }}
        >
          <SessionChat />
        </div>
      )}
    </>
  );
}

const PANEL_CSS = `
/* Control buttons (mic/cam/screen-share) — round, dark when enabled,
   red when muted/off. TrackToggle sets aria-pressed="true" when enabled. */
.hc-control {
  width: 40px !important;
  height: 40px !important;
  min-width: 40px !important;
  border-radius: 9999px !important;
  border: 1px solid rgba(255,255,255,0.08) !important;
  background: rgba(39,39,42,0.9) !important;
  color: #fafafa !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: pointer !important;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease !important;
  padding: 0 !important;
  gap: 0 !important;
  line-height: 0 !important;
  font-size: 0 !important;
  overflow: hidden !important;
}
.hc-control:hover { background: rgba(63,63,70,0.95) !important; transform: translateY(-1px); }
.hc-control:active { transform: translateY(0); }
.hc-control.hc-active {
  background: #C4198B !important;
  border-color: #C4198B !important;
  color: #fff !important;
}
.hc-control.hc-active:hover { background: #a8137a !important; }
/* Icon toggle: show .hc-icon-on when enabled, .hc-icon-off when not. */
.hc-icon-toggle[aria-pressed="true"] .hc-icon-off { display: none !important; }
.hc-icon-toggle[aria-pressed="false"] .hc-icon-on { display: none !important; }
.hc-icon-toggle:not([aria-pressed]) .hc-icon-off { display: none !important; }
/* Smaller variant for the minimized header — 28px circle. */
.hc-control.hc-control-sm {
  width: 28px !important;
  height: 28px !important;
  min-width: 28px !important;
  position: relative !important;
}
.hc-control.hc-control-sm > * {
  width: 13px !important;
  height: 13px !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
}
.hc-control.hc-control-sm svg,
.hc-control.hc-control-sm .lk-icon,
.hc-control.hc-control-sm .lk-icon svg {
  width: 13px !important;
  height: 13px !important;
  display: block !important;
}
.hc-control svg, .hc-control .lk-icon, .hc-control .lk-icon svg {
  width: 16px !important;
  height: 16px !important;
  flex-shrink: 0 !important;
  display: block !important;
  stroke-width: 2 !important;
}
/* LiveKit TrackToggle may render a text label after the icon — hide it. */
.hc-control > span:not(.lk-icon):not([class*="icon"]) { display: none !important; }
/* Only mic/cam turn red when off — "muted" is a real problem state.
   Screen-share/draw/chat toggles stay neutral when off (they're not
   errors, just inactive). */
.hc-control[data-lk-source="microphone"][aria-pressed="false"],
.hc-control[data-lk-source="camera"][aria-pressed="false"] {
  background: #dc2626 !important;
  border-color: #b91c1c !important;
  color: #fff !important;
}
.hc-control[data-lk-source="microphone"][aria-pressed="false"]:hover,
.hc-control[data-lk-source="camera"][aria-pressed="false"]:hover {
  background: #ef4444 !important;
}
/* Screen share: magenta when actively sharing (aria-pressed="true"). */
.hc-control[data-lk-source="screen_share"][aria-pressed="true"] {
  background: #C4198B !important;
  border-color: #C4198B !important;
  color: #fff !important;
}
.hc-control[data-lk-source="screen_share"][aria-pressed="true"]:hover {
  background: #a8137a !important;
}

/* Disable LiveKit's default blue speaking ring — our magenta border on the
   tile is the single source of truth. LiveKit renders the ring via ::after
   and/or a .lk-speaking-indicator element, and exposes --lk-accent-bg too. */
.lk-participant-tile::after,
.lk-participant-tile::before {
  display: none !important;
  content: none !important;
  box-shadow: none !important;
  outline: none !important;
}
.lk-participant-tile {
  --lk-accent-bg: transparent !important;
  outline: none !important;
  box-shadow: none !important;
}
.lk-participant-tile[data-lk-speaking="true"],
.lk-participant-tile.lk-speaking {
  outline: none !important;
  box-shadow: none !important;
}
.lk-speaking-indicator,
.lk-participant-tile > .lk-focus-toggle-button { display: none !important; }

.lk-chat {
  background: transparent !important;
  border: none !important;
  font-family: inherit;
  width: 100% !important;
  box-sizing: border-box !important;
  display: flex !important;
  flex-direction: column !important;
}
.lk-chat > * { box-sizing: border-box !important; max-width: 100% !important; }
.lk-chat-header,
.lk-chat > h3,
.lk-chat > h2,
.lk-chat > header {
  padding: 10px 14px !important;
  margin: 0 !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  color: #d4d4d8 !important;
  height: 40px !important;
  text-transform: none !important;
  text-align: left !important;
  border-bottom: 1px solid rgba(255,255,255,0.06) !important;
  background: transparent !important;
  width: 100% !important;
  box-sizing: border-box !important;
  display: block !important;
}
.lk-chat-header > *,
.lk-chat > header > * {
  border: none !important;
  padding: 0 !important;
  margin: 0 !important;
  font-size: inherit !important;
  color: inherit !important;
  width: auto !important;
  display: inline !important;
}
.lk-chat-messages-container, .lk-chat-messages, ul.lk-list {
  padding: 10px 12px !important;
  gap: 8px !important;
  list-style: none !important;
  margin: 0 !important;
  overflow-y: auto !important;
  flex: 1 !important;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.15) transparent;
}
.lk-chat-messages-container::-webkit-scrollbar, .lk-chat-messages::-webkit-scrollbar, ul.lk-list::-webkit-scrollbar { width: 6px; }
.lk-chat-messages-container::-webkit-scrollbar-thumb, .lk-chat-messages::-webkit-scrollbar-thumb, ul.lk-list::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.12); border-radius: 3px;
}
.lk-chat-entry {
  background: rgba(39,39,42,0.65) !important;
  border-radius: 10px !important;
  padding: 6px 10px !important;
  font-size: 12px !important;
  line-height: 1.35 !important;
  word-break: break-word !important;
}
.lk-chat-entry .lk-participant-name,
.lk-chat-entry .lk-meta-data {
  font-size: 10px !important;
  color: #a1a1aa !important;
  font-weight: 500 !important;
}
.lk-chat-entry .lk-message-body { color: #fafafa !important; margin-top: 2px !important; }
.lk-chat-form {
  padding: 8px 10px !important;
  gap: 6px !important;
  border-top: 1px solid rgba(255,255,255,0.04) !important;
  background: rgba(15,15,17,0.5) !important;
  display: flex !important;
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  margin: 0 !important;
  align-items: center !important;
}
.lk-chat-form-input {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  width: 100% !important;
  background: rgba(39,39,42,0.8) !important;
  border: 1px solid rgba(255,255,255,0.08) !important;
  border-radius: 8px !important;
  color: #fafafa !important;
  padding: 8px 12px !important;
  font-size: 12px !important;
  outline: none !important;
  box-sizing: border-box !important;
}
.lk-chat-form-input::placeholder { color: #71717a !important; }
.lk-chat-form-input:focus { border-color: #C4198B !important; }
.lk-chat-form-button {
  background: #C4198B !important;
  color: #fff !important;
  border: none !important;
  border-radius: 8px !important;
  padding: 6px 12px !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  flex-shrink: 0 !important;
}
.lk-chat-form-button:hover { background: #a8137a !important; }
.lk-chat-messages:empty::before, ul.lk-list:empty::before {
  content: "Say hi 👋";
  display: block;
  padding: 16px;
  text-align: center;
  color: #52525b;
  font-size: 11px;
}
`;

function SessionChat() {
  const messages = useSessionChatMessages();
  const { room: colyseusRoom, currentUser } = useSharedSessionStore();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const myUserId = currentUser?.userId ?? "";

  // Auto-scroll to bottom on new message. We only scroll if the user is
  // already near the bottom — otherwise jumping past scrollback they're
  // reading would be jarring.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !colyseusRoom) return;
    sendSessionChat(colyseusRoom, draft);
    setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          padding: "10px 14px",
          fontSize: 12,
          fontWeight: 600,
          color: "#d4d4d8",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        Messages
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: "#52525b",
              fontSize: 11,
              padding: 16,
            }}
          >
            Say hi 👋
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.userId === myUserId;
            return (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: mine ? "flex-end" : "flex-start",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "#a1a1aa",
                    fontWeight: 500,
                    paddingInline: 2,
                  }}
                >
                  {m.username || "?"}
                </div>
                <div
                  style={{
                    background: mine ? "rgba(196,25,139,0.25)" : "rgba(39,39,42,0.8)",
                    border: mine
                      ? "1px solid rgba(196,25,139,0.4)"
                      : "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 10,
                    padding: "6px 10px",
                    fontSize: 12,
                    color: "#fafafa",
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                    maxWidth: "85%",
                  }}
                >
                  {m.content}
                </div>
              </div>
            );
          })
        )}
      </div>
      <form
        onSubmit={onSubmit}
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 10px",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          background: "rgba(15,15,17,0.5)",
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Enter a message..."
          style={{
            flex: 1,
            minWidth: 0,
            background: "rgba(39,39,42,0.8)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            color: "#fafafa",
            padding: "8px 12px",
            fontSize: 12,
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          style={{
            background: draft.trim() ? "#C4198B" : "rgba(196,25,139,0.4)",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 500,
            cursor: draft.trim() ? "pointer" : "default",
            fontFamily: "inherit",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function ParticipantGrid({
  cols,
  expanded,
  fillHeight,
  tileSize,
}: {
  cols: number;
  expanded: boolean;
  fillHeight?: boolean;
  tileSize: number;
}) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const screenShares = tracks.filter((t) => t.source === Track.Source.ScreenShare);
  const cameraTracks = tracks.filter((t) => t.source === Track.Source.Camera);
  // `withPlaceholder: true` should create a placeholder per participant who
  // hasn't published a camera, but it can be flaky for the local participant
  // right after join when mic+cam started muted. Guarantee one tile per
  // participant by synthesizing placeholders for anyone missing.
  const cameras: TrackReferenceOrPlaceholder[] = participants.map((p) => {
    const existing = cameraTracks.find((t) => t.participant.sid === p.sid);
    if (existing) return existing;
    return { participant: p, source: Track.Source.Camera } as TrackReferenceOrPlaceholder;
  });
  const focus = screenShares[0];

  // Meet-style: one big focus tile (screen share) + camera strip on the side.
  if (focus) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: expanded ? "minmax(0, 3fr) 180px" : "minmax(0, 2fr) 120px",
          gap: 8,
          padding: "8px 8px 12px 8px",
          backgroundColor: "#09090b",
          ...(fillHeight ? { width: "100%", height: "100%" } : {}),
        }}
      >
        <TrackRefContext.Provider key={focus.participant.sid + focus.source} value={focus}>
          <CustomTile trackRef={focus} noAspectRatio={fillHeight} />
        </TrackRefContext.Provider>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          {cameras.map((trackRef) => (
            <TrackRefContext.Provider
              key={trackRef.participant.sid + trackRef.source}
              value={trackRef}
            >
              <CustomTile trackRef={trackRef} aspectRatio="1/1" />
            </TrackRefContext.Provider>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: fillHeight ? `repeat(${cols}, 1fr)` : `repeat(${cols}, ${tileSize}px)`,
        gap: 8,
        padding: 6,
        backgroundColor: "#09090b",
        ...(fillHeight ? { width: "100%", height: "100%" } : { width: "100%" }),
      }}
    >
      {cameras.map((trackRef) => (
        <TrackRefContext.Provider key={trackRef.participant.sid + trackRef.source} value={trackRef}>
          <CustomTile trackRef={trackRef} noAspectRatio={fillHeight} />
        </TrackRefContext.Provider>
      ))}
    </div>
  );
}

function CustomTile({
  trackRef,
  noAspectRatio,
  aspectRatio = "4/3",
}: {
  trackRef: TrackReferenceOrPlaceholder;
  noAspectRatio?: boolean;
  aspectRatio?: string;
}) {
  const cameraMuted = useIsMuted({
    source: Track.Source.Camera,
    participant: trackRef.participant,
  });
  const micMuted = useIsMuted({
    source: Track.Source.Microphone,
    participant: trackRef.participant,
  });
  const speaking = useIsSpeaking(trackRef.participant);
  let avatarUrl = "";
  try {
    const meta = trackRef.participant.metadata
      ? (JSON.parse(trackRef.participant.metadata) as { avatarUrl?: string })
      : null;
    avatarUrl = meta?.avatarUrl ?? "";
  } catch {}
  const name = trackRef.participant.name || trackRef.participant.identity;
  const initial = (name?.trim().charAt(0) || "?").toUpperCase();
  const showAvatar = cameraMuted || !trackRef.publication;
  return (
    <div
      style={{
        position: "relative",
        ...(noAspectRatio
          ? { width: "100%", height: "100%", minHeight: 0 }
          : { aspectRatio, width: "100%" }),
        borderRadius: 8,
        overflow: "hidden",
        border: speaking ? "2px solid #C4198B" : "1px solid rgba(255,255,255,0.04)",
        boxShadow: speaking ? "0 0 0 2px rgba(196,25,139,0.35)" : "none",
        transition: "border-color 120ms ease, box-shadow 120ms ease",
        background: "#09090b",
      }}
    >
      {showAvatar ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(180deg, #1a1a1d 0%, #0a0a0c 100%)",
          }}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={name}
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                objectFit: "cover",
                border: "2px solid rgba(255,255,255,0.12)",
              }}
            />
          ) : (
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "#C4198B",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: 20,
                fontWeight: 600,
              }}
            >
              {initial}
            </div>
          )}
        </div>
      ) : (
        <VideoTrack
          trackRef={trackRef}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      <div
        style={{
          position: "absolute",
          bottom: 6,
          left: 6,
          fontSize: 10,
          fontWeight: 500,
          color: "#e5e5e5",
          backgroundColor: "rgba(0,0,0,0.55)",
          padding: "2px 8px",
          borderRadius: 6,
          maxWidth: "calc(100% - 12px)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          pointerEvents: "none",
        }}
      >
        {name}
      </div>
    </div>
  );
}

// Render both icons and toggle via CSS on [aria-pressed]. Simpler than
// unwrapping LiveKit's useTrackToggle and re-implementing the click handler.
function MicToggle({ compact }: { compact?: boolean }) {
  const cls = `hc-control hc-icon-toggle${compact ? " hc-control-sm" : ""}`;
  const size = compact ? 13 : 16;
  return (
    <TrackToggle source={Track.Source.Microphone} className={cls} showIcon={false}>
      <Mic size={size} color="#fafafa" className="hc-icon-on" />
      <MicOff size={size} color="#fafafa" className="hc-icon-off" />
    </TrackToggle>
  );
}

function CamToggle({ compact }: { compact?: boolean }) {
  const cls = `hc-control hc-icon-toggle${compact ? " hc-control-sm" : ""}`;
  const size = compact ? 13 : 16;
  return (
    <TrackToggle source={Track.Source.Camera} className={cls} showIcon={false}>
      <Video size={size} color="#fafafa" className="hc-icon-on" />
      <VideoOff size={size} color="#fafafa" className="hc-icon-off" />
    </TrackToggle>
  );
}

function DrawControls({
  roomSend,
  compact,
  disabled,
}: {
  roomSend: (type: string, payload?: unknown) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { active, color } = useSharedDrawState();
  const pencilBtnRef = useRef<HTMLButtonElement | null>(null);
  // Auto-stop drawing when disabled (e.g., panel expanded and covers workspace).
  useEffect(() => {
    if (disabled && active) {
      setDrawActive(false);
    }
  }, [disabled, active]);
  const isOn = active && !disabled;
  const paletteOpen = isOn;
  const btnClass = `hc-control${compact ? " hc-control-sm" : ""}${isOn ? " hc-active" : ""}`;
  const disabledTitle =
    "Drawing is disabled while the video panel is enlarged — shrink it first to annotate your workspace.";
  return (
    <div style={{ position: "relative", display: "flex", gap: 6 }}>
      <button
        ref={pencilBtnRef}
        onClick={() => {
          if (disabled) return;
          setDrawActive(!active);
        }}
        className={btnClass}
        disabled={disabled}
        title={disabled ? disabledTitle : isOn ? "Stop drawing" : "Start drawing"}
        style={{
          ...(isOn ? { background: color, borderColor: color } : {}),
          ...(disabled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
        }}
        aria-label={disabled ? disabledTitle : isOn ? "Stop drawing" : "Start drawing"}
      >
        <Pencil size={compact ? 13 : 16} color="#fafafa" />
      </button>
      {paletteOpen &&
        pencilBtnRef.current &&
        typeof document !== "undefined" &&
        createPortal(
          <PalettePopover
            anchor={pencilBtnRef.current}
            currentColor={color}
            onPick={setDrawColor}
            onClear={() => {
              roomSend("draw_clear");
              requestDrawClear();
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function PalettePopover({
  anchor,
  currentColor,
  onPick,
  onClear,
}: {
  anchor: HTMLElement;
  currentColor: string;
  onPick: (c: string) => void;
  onClear: () => void;
}) {
  // Track anchor position so the palette follows the floating panel as it
  // moves or the window resizes.
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
  useEffect(() => {
    let raf = 0;
    const update = () => setRect(anchor.getBoundingClientRect());
    const tick = () => {
      update();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  return (
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top - 40,
        display: "flex",
        gap: 6,
        padding: 6,
        borderRadius: 10,
        background: "rgba(10,10,10,0.95)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        zIndex: 10001,
      }}
    >
      {DRAW_PALETTE.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          aria-label={`Color ${c}`}
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: c,
            border: c === currentColor ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
            cursor: "pointer",
          }}
        />
      ))}
      <div
        style={{
          width: 1,
          alignSelf: "stretch",
          background: "rgba(255,255,255,0.12)",
          margin: "0 2px",
        }}
      />
      <button
        onClick={onClear}
        aria-label="Clear drawings"
        title="Clear drawings"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "rgba(39,39,42,0.9)",
          border: "1px solid rgba(255,255,255,0.12)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        <Trash2 size={12} color="#fafafa" />
      </button>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const lkToggleStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(39,39,42,0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

function ctrlBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.08)",
    background: active ? "rgba(196,25,139,0.18)" : "rgba(39,39,42,0.8)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  };
}
