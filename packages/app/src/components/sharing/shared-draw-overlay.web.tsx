import { useEffect, useRef, useState } from "react";
import {
  useIsInSharedSession,
  useSharedSessionStore,
} from "@/stores/shared-session-store";
import { useSharedDrawState } from "@/stores/shared-draw-store";

interface Point {
  x: number; // normalized 0..1 relative to viewport
  y: number;
}

interface Stroke {
  id: string;
  userId: string;
  color: string;
  points: Point[];
  /** Timestamp when the last point was added. Used to compute fade. */
  lastAt: number;
  /** True once the remote peer signaled the stroke is finished. */
  ended: boolean;
}

// Slack-style: the stroke starts fading the moment the user lifts the
// pen, and gently disappears over a few seconds.
const STROKE_FADE_MS = 4000;
const FLUSH_INTERVAL_MS = 60;

// Fixed overlay spanning the viewport so every participant draws in the same
// coordinate space (points are normalized 0..1 and resolved against each
// viewer's viewport). Slack does the same — strokes follow the visible region.
export function SharedDrawOverlay() {
  const isInSharedSession = useIsInSharedSession();
  const { room, currentUser } = useSharedSessionStore();
  const { active: drawActive, color } = useSharedDrawState();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [, forceRender] = useState(0);
  const strokesRef = useRef<Map<string, Stroke>>(new Map());

  // --- receive strokes from peers ---------------------------------------
  useEffect(() => {
    if (!room?.onMessage) return;
    const handleStroke = (msg: any) => {
      const id: string | undefined = msg?.strokeId;
      const points: Point[] | undefined = msg?.points;
      if (!id || !Array.isArray(points)) return;
      const existing = strokesRef.current.get(id);
      const now = Date.now();
      if (existing) {
        existing.points.push(...points);
        existing.lastAt = now;
        if (msg.end) existing.ended = true;
      } else {
        strokesRef.current.set(id, {
          id,
          userId: String(msg.userId ?? "remote"),
          color: typeof msg.color === "string" ? msg.color : "#ff3b8d",
          points: [...points],
          lastAt: now,
          ended: !!msg.end,
        });
      }
    };
    const handleClear = () => {
      strokesRef.current.clear();
    };
    room.onMessage("draw_stroke", handleStroke);
    room.onMessage("draw_clear", handleClear);
  }, [room]);

  // --- redraw loop ------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const now = Date.now();
      // Slack-style group fade: while *any* stroke is still in progress,
      // keep every drawing at full opacity. Only once all strokes are
      // finished does the whole batch start fading together, starting
      // from the moment the last stroke ended.
      let anyActive = false;
      let latestEndedAt = 0;
      for (const stroke of strokesRef.current.values()) {
        if (!stroke.ended) {
          anyActive = true;
          break;
        }
        if (stroke.lastAt > latestEndedAt) latestEndedAt = stroke.lastAt;
      }
      const fadeAge = anyActive ? 0 : now - latestEndedAt;
      const expired: string[] = [];
      for (const stroke of strokesRef.current.values()) {
        let alpha = 1;
        if (!anyActive && fadeAge > 0) {
          if (fadeAge >= STROKE_FADE_MS) {
            expired.push(stroke.id);
            continue;
          }
          // Ease-out curve: stays visible for a moment, then fades quicker
          // at the tail — mirrors Slack's "temporary annotation" feel.
          const t = fadeAge / STROKE_FADE_MS;
          alpha = Math.pow(1 - t, 1.6);
        }

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        stroke.points.forEach((p, idx) => {
          const x = p.x * w;
          const y = p.y * h;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const id of expired) strokesRef.current.delete(id);

      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  // --- local drawing handlers ------------------------------------------
  const activeStrokeRef = useRef<{
    id: string;
    pendingPoints: Point[];
    flushTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  useEffect(() => {
    if (!drawActive) {
      // If user turns off draw mode mid-stroke, finalize it.
      const active = activeStrokeRef.current;
      if (active && room?.send) {
        room.send("draw_stroke", {
          strokeId: active.id,
          color,
          points: active.pendingPoints,
          end: true,
        });
      }
      activeStrokeRef.current = null;
      forceRender((n) => n + 1);
    }
  }, [drawActive, room, color]);

  const flushPending = (end: boolean) => {
    const active = activeStrokeRef.current;
    if (!active || !room?.send) return;
    if (active.pendingPoints.length === 0 && !end) return;
    room.send("draw_stroke", {
      strokeId: active.id,
      color,
      points: active.pendingPoints,
      end,
    });
    active.pendingPoints = [];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawActive || !currentUser) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const now = Date.now();
    const strokeId = `${currentUser.userId}-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const p = normalize(e);
    activeStrokeRef.current = { id: strokeId, pendingPoints: [p], flushTimer: null };
    strokesRef.current.set(strokeId, {
      id: strokeId,
      userId: currentUser.userId,
      color,
      points: [p],
      lastAt: now,
      ended: false,
    });
    // First flush immediately so peers see the starting point.
    flushPending(false);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawActive) return;
    const active = activeStrokeRef.current;
    if (!active) return;
    const p = normalize(e);
    active.pendingPoints.push(p);
    const local = strokesRef.current.get(active.id);
    if (local) {
      local.points.push(p);
      local.lastAt = Date.now();
    }
    if (!active.flushTimer) {
      active.flushTimer = setTimeout(() => {
        if (activeStrokeRef.current === active) {
          flushPending(false);
          active.flushTimer = null;
        }
      }, FLUSH_INTERVAL_MS);
    }
  };

  const handlePointerUp = () => {
    if (!drawActive) return;
    const active = activeStrokeRef.current;
    if (!active) return;
    if (active.flushTimer) clearTimeout(active.flushTimer);
    flushPending(true);
    const local = strokesRef.current.get(active.id);
    if (local) {
      local.ended = true;
      local.lastAt = Date.now();
    }
    activeStrokeRef.current = null;
  };

  if (!isInSharedSession) return null;

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        pointerEvents: drawActive ? "auto" : "none",
        cursor: drawActive ? "crosshair" : "default",
        touchAction: drawActive ? "none" : "auto",
      }}
    />
  );
}

function normalize(e: React.PointerEvent<HTMLCanvasElement>): Point {
  return {
    x: e.clientX / window.innerWidth,
    y: e.clientY / window.innerHeight,
  };
}
