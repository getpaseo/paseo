import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSharedSessionStore } from "@/stores/shared-session-store";
import { userColor } from "@/utils/user-color";

interface RemoteCursor {
  userId: string;
  username: string;
  color: string;
  x: number; // normalized 0..1 relative to shared viewport
  y: number;
  lastAt: number;
  visible: boolean;
}

const SEND_INTERVAL_MS = 50;
const IDLE_FADE_MS = 5000;
const VIEWPORT_ID = "hc-shared-viewport";

// Cursors normalize against the shared viewport element (#hc-shared-viewport),
// NOT window.innerWidth/Height. This is critical: the left sidebar can be open
// on one client and closed on another, which shifts the visible work area. If
// we normalized against the window, a cursor at the agent panel's left edge
// would land in a different logical spot for each viewer.
function getViewport(): DOMRect | null {
  const el = document.getElementById(VIEWPORT_ID);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

export function SharedCursorsOverlay() {
  const { room, currentUser } = useSharedSessionStore();
  const isInSharedSession = !!room;
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const [, forceRender] = useState(0);
  const lastSendRef = useRef(0);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!room?.onMessage) return;
    const off = room.onMessage("cursor_move", (msg: any) => {
      const userId = String(msg?.userId ?? "");
      if (!userId) return;
      if (currentUser && userId === currentUser.userId) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      cursorsRef.current.set(userId, {
        userId,
        username: String(msg.username ?? ""),
        color: userColor(userId),
        x,
        y,
        lastAt: Date.now(),
        visible: msg.visible !== false,
      });
      forceRender((n) => (n + 1) & 0xffff);
    });
    return () => {
      try {
        (off as unknown as () => void)?.();
      } catch {}
    };
  }, [room, currentUser]);

  useEffect(() => {
    if (!isInSharedSession) return;
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, c] of cursorsRef.current) {
        if (now - c.lastAt > IDLE_FADE_MS) {
          cursorsRef.current.delete(key);
          changed = true;
        }
      }
      if (changed) forceRender((n) => (n + 1) & 0xffff);
      // Also re-render so cursors track layout changes (sidebar toggle,
      // window resize) even when no new messages arrive.
      forceRender((n) => (n + 1) & 0xffff);
    }, 500);
    return () => clearInterval(interval);
  }, [isInSharedSession]);

  useEffect(() => {
    if (!isInSharedSession || !room?.send) return;
    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastSendRef.current < SEND_INTERVAL_MS) return;
      const vp = getViewport();
      if (!vp) return;
      // Only broadcast when the pointer is inside the shared viewport. Cursors
      // over the local sidebar are meaningless to remote viewers whose sidebar
      // state differs.
      const insideX = e.clientX >= vp.left && e.clientX <= vp.right;
      const insideY = e.clientY >= vp.top && e.clientY <= vp.bottom;
      if (!insideX || !insideY) {
        if (lastPosRef.current) {
          try {
            room.send("cursor_move", {
              x: lastPosRef.current.x,
              y: lastPosRef.current.y,
              visible: false,
            });
          } catch {}
          lastPosRef.current = null;
          lastSendRef.current = now;
        }
        return;
      }
      lastSendRef.current = now;
      const x = (e.clientX - vp.left) / vp.width;
      const y = (e.clientY - vp.top) / vp.height;
      lastPosRef.current = { x, y };
      try {
        room.send("cursor_move", { x, y, visible: true });
      } catch {}
    };
    const onLeave = () => {
      if (!lastPosRef.current) return;
      try {
        room.send("cursor_move", {
          x: lastPosRef.current.x,
          y: lastPosRef.current.y,
          visible: false,
        });
      } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [room, isInSharedSession]);

  if (!isInSharedSession) return null;
  if (typeof document === "undefined") return null;

  const vp = getViewport();
  if (!vp) return null;

  const cursors = Array.from(cursorsRef.current.values()).filter((c) => c.visible);

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: vp.left,
        top: vp.top,
        width: vp.width,
        height: vp.height,
        pointerEvents: "none",
        zIndex: 9997,
        overflow: "hidden",
      }}
    >
      {cursors.map((c) => (
        <div
          key={c.userId}
          style={{
            position: "absolute",
            left: `${c.x * 100}%`,
            top: `${c.y * 100}%`,
            transform: "translate(-2px, -2px)",
            transition: "left 80ms linear, top 80ms linear",
            willChange: "left, top",
          }}
        >
          <svg
            width="20"
            height="22"
            viewBox="0 0 20 22"
            style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))" }}
          >
            <path
              d="M2 2 L2 17 L6.5 13 L9.5 19.5 L12 18.5 L9 12 L15 12 Z"
              fill={c.color}
              stroke="white"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          <div
            style={{
              position: "absolute",
              top: 18,
              left: 14,
              background: c.color,
              color: "white",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              whiteSpace: "nowrap",
              boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            }}
          >
            {c.username || "member"}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
