import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSharedSessionStore } from "@/stores/shared-session-store";
import { userColor } from "@/utils/user-color";
import {
  broadcastSelectionRects,
  resetSelectionBroadcast,
} from "@/components/sharing/shared-selection-broadcaster";

/**
 * Remote text-selection overlay.
 *
 * Rects are exchanged RELATIVE TO A MESSAGE ANCHOR (`[data-shared-anchor]`)
 * — not to the viewport, not to the chat scroll container. Ancestor content
 * can differ across clients (a Thinking block may be expanded on one side and
 * collapsed on the other), so any coordinate system that accumulates offsets
 * across messages will drift. Anchoring inside the selected message itself
 * makes the highlight align perfectly as long as that one message renders
 * the same text at the same width on both peers.
 *
 * Payload shape per rect: `{ anchorId, x, y, w, h }` where (x,y) are in
 * pixels relative to the top-left of the anchor element's bounding box.
 *
 * For multi-message selections each rect still carries its own anchorId,
 * so line N of message A and line M of message B line up independently.
 */

interface AnchoredRect {
  anchorId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RemoteSelection {
  userId: string;
  username: string;
  color: string;
  rects: AnchoredRect[];
  lastAt: number;
}

const SEND_INTERVAL_MS = 80;
const IDLE_CLEAR_MS = 60_000;
const MAX_RECTS = 80;
const SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';

const ANCHOR_PREFIX = "shared-anchor-";

function findAnchor(node: Node | null): HTMLElement | null {
  let el: Element | null = node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  while (el) {
    if (el instanceof HTMLElement && el.id.startsWith(ANCHOR_PREFIX)) return el;
    el = el.parentElement;
  }
  return null;
}

function anchorIdOf(el: HTMLElement): string {
  return el.id.slice(ANCHOR_PREFIX.length);
}

export function SharedSelectionOverlay() {
  const { room, currentUser } = useSharedSessionStore();
  const isInSharedSession = !!room;
  const selectionsRef = useRef<Map<string, RemoteSelection>>(new Map());
  const [, forceRender] = useState(0);
  const lastSendRef = useRef(0);
  const pendingSendRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!room?.onMessage) return;
    const off = room.onMessage("selection_rects", (msg: any) => {
      const userId = String(msg?.userId ?? "");
      if (!userId) return;
      if (currentUser && userId === currentUser.userId) return;
      const rawRects = Array.isArray(msg.rects) ? msg.rects : [];
      const rects: AnchoredRect[] = [];
      for (const r of rawRects.slice(0, MAX_RECTS)) {
        const anchorId = String(r?.anchorId ?? "");
        if (!anchorId) continue;
        const x = Number(r?.x);
        const y = Number(r?.y);
        const w = Number(r?.w);
        const h = Number(r?.h);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        if (w <= 0 || h <= 0) continue;
        rects.push({ anchorId, x, y, w, h });
      }
      if (rects.length === 0) {
        selectionsRef.current.delete(userId);
      } else {
        selectionsRef.current.set(userId, {
          userId,
          username: String(msg.username ?? ""),
          color: userColor(userId),
          rects,
          lastAt: Date.now(),
        });
      }
      forceRender((n) => (n + 1) & 0xffff);
    });
    return () => {
      try {
        (off as unknown as () => void)?.();
      } catch {}
    };
  }, [room, currentUser]);

  // Re-render on layout + scroll so peer highlights track layout changes
  // (window resize, scroll inside the chat, sidebar toggle, etc.). The
  // rects are anchor-relative, but the anchor element's screen position
  // changes when the container scrolls on the receiver's side.
  useEffect(() => {
    if (!isInSharedSession) return;
    const onAny = () => forceRender((n) => (n + 1) & 0xffff);
    window.addEventListener("resize", onAny);
    window.addEventListener("scroll", onAny, true);

    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, s] of selectionsRef.current) {
        if (now - s.lastAt > IDLE_CLEAR_MS) {
          selectionsRef.current.delete(key);
          changed = true;
        }
      }
      onAny();
      if (changed) onAny();
    }, 250);

    return () => {
      window.removeEventListener("resize", onAny);
      window.removeEventListener("scroll", onAny, true);
      clearInterval(interval);
    };
  }, [isInSharedSession]);

  // Broadcast local DOM selection. Each rect is anchored to the nearest
  // ancestor carrying `data-shared-anchor`. If the selection sits outside
  // any anchor, it's ignored (not sharable).
  useEffect(() => {
    if (!isInSharedSession || !room?.send) return;

    const sendNow = () => {
      const selection = window.getSelection();
      let rects: AnchoredRect[] = [];
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const anchorNode = selection.anchorNode;
        const anchorElClosest =
          anchorNode?.nodeType === 1
            ? (anchorNode as Element)
            : (anchorNode?.parentElement ?? null);
        const insideMonaco = !!anchorElClosest?.closest?.(".monaco-editor");
        if (!insideMonaco) {
          const range = selection.getRangeAt(0);
          const clientRects = range.getClientRects();
          for (let i = 0; i < clientRects.length && rects.length < MAX_RECTS; i++) {
            const r = clientRects[i];
            if (!r || r.width <= 0 || r.height <= 0) continue;
            // Find the anchor element whose box contains this rect's center.
            // range.getClientRects doesn't hand us the node per rect, so we
            // resolve via elementFromPoint — if the hit element sits under a
            // shared anchor, we report against it.
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            const anchor = findAnchor(hit);
            if (!anchor) continue;
            const ar = anchor.getBoundingClientRect();
            rects.push({
              anchorId: anchorIdOf(anchor),
              x: r.left - ar.left,
              y: r.top - ar.top,
              w: r.width,
              h: r.height,
            });
          }
        }
      }

      broadcastSelectionRects("dom", rects);
    };

    const scheduleSend = () => {
      const now = Date.now();
      const elapsed = now - lastSendRef.current;
      if (elapsed >= SEND_INTERVAL_MS) {
        lastSendRef.current = now;
        sendNow();
      } else if (!pendingSendRef.current) {
        pendingSendRef.current = setTimeout(() => {
          pendingSendRef.current = null;
          lastSendRef.current = Date.now();
          sendNow();
        }, SEND_INTERVAL_MS - elapsed);
      }
    };

    document.addEventListener("selectionchange", scheduleSend);
    return () => {
      document.removeEventListener("selectionchange", scheduleSend);
      if (pendingSendRef.current) {
        clearTimeout(pendingSendRef.current);
        pendingSendRef.current = null;
      }
      broadcastSelectionRects("dom", []);
      resetSelectionBroadcast();
    };
  }, [room, isInSharedSession]);

  if (!isInSharedSession) return null;
  if (typeof document === "undefined") return null;

  // Clip overlay to the chat scroll container so highlights don't leak
  // outside when a message is scrolled partially off-screen.
  const clipEl = (document.querySelector(SCROLL_SELECTOR) as HTMLElement | null) ?? null;
  const clipRect = clipEl?.getBoundingClientRect();

  const anchorCache = new Map<string, DOMRect | null>();
  const getAnchorRect = (id: string): DOMRect | null => {
    if (anchorCache.has(id)) return anchorCache.get(id) ?? null;
    const el = document.getElementById(`${ANCHOR_PREFIX}${id}`);
    const rect = el?.getBoundingClientRect() ?? null;
    anchorCache.set(id, rect);
    return rect;
  };

  const selections = Array.from(selectionsRef.current.values());

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: clipRect?.left ?? 0,
        top: clipRect?.top ?? 0,
        width: clipRect?.width ?? window.innerWidth,
        height: clipRect?.height ?? window.innerHeight,
        pointerEvents: "none",
        zIndex: 9996,
        overflow: "hidden",
      }}
    >
      {selections.map((s) => {
        // Find the first resolvable anchor in the selection to place the
        // user's name label.
        const firstResolvable = s.rects.find((r) => !!getAnchorRect(r.anchorId));
        const firstAnchorRect = firstResolvable ? getAnchorRect(firstResolvable.anchorId) : null;
        return (
          <div key={s.userId}>
            {s.rects.map((r, i) => {
              const ar = getAnchorRect(r.anchorId);
              if (!ar) return null;
              // Convert anchor-relative → overlay-relative (overlay is fixed
              // at clipRect's origin).
              const overlayLeft = clipRect?.left ?? 0;
              const overlayTop = clipRect?.top ?? 0;
              const screenX = ar.left + r.x - overlayLeft;
              const screenY = ar.top + r.y - overlayTop;
              return (
                <div
                  key={`${s.userId}-${i}`}
                  style={{
                    position: "absolute",
                    left: screenX,
                    top: screenY,
                    width: r.w,
                    height: r.h,
                    backgroundColor: s.color,
                    opacity: 0.28,
                    borderRadius: 2,
                    mixBlendMode: "multiply",
                  }}
                />
              );
            })}
            {firstAnchorRect && firstResolvable && (
              <div
                style={{
                  position: "absolute",
                  left: firstAnchorRect.left + firstResolvable.x - (clipRect?.left ?? 0),
                  top: firstAnchorRect.top + firstResolvable.y - (clipRect?.top ?? 0) - 14,
                  background: s.color,
                  color: "white",
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 5px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                }}
              >
                {s.username || "member"}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
