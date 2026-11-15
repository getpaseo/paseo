import { createContext, useContext, useSyncExternalStore } from "react";
import type { MockupStateId } from "./states";

/**
 * Which scene the mockup shows and how far into its script each scene is. The player owns the
 * clock. Components read the time through `useSceneClock` and never keep time themselves.
 */
export interface ScenePlayer {
  scene(): MockupStateId;
  /** Milliseconds into a scene's script. Each scene keeps its own, so a scene that is fading out holds its last frame. */
  elapsed(scene: MockupStateId): number;
  /** Shows a scene and plays its script from the start. */
  select(scene: MockupStateId): void;
  /** Plays the current scene from the start. Returns a function that stops the clock. */
  start(): () => void;
  subscribe(listener: () => void): () => void;
}

// A background tab stops animation frames. On return the script resumes where it paused.
const LONGEST_FRAME_MS = 64;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param durations How long each scene's script runs. A scene without a script has no entry and is
 * always at its finished state.
 */
export function createScenePlayer(
  initial: MockupStateId,
  durations: Partial<Record<MockupStateId, number>>,
): ScenePlayer {
  let scene = initial;
  const times = new Map<MockupStateId, number>();
  const listeners = new Set<() => void>();
  let frame = 0;
  let lastFrameAt = 0;

  function emit() {
    for (const listener of listeners) listener();
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function tick(now: number) {
    const end = durations[scene] ?? 0;
    const next = Math.min(
      end,
      (times.get(scene) ?? 0) + Math.min(now - lastFrameAt, LONGEST_FRAME_MS),
    );
    lastFrameAt = now;
    times.set(scene, next);
    frame = next < end ? requestAnimationFrame(tick) : 0;
    emit();
  }

  function play() {
    stop();
    const end = durations[scene] ?? 0;
    // Visitors who ask for reduced motion get the finished scene.
    const animated = end > 0 && !prefersReducedMotion();
    times.set(scene, animated ? 0 : end);
    if (animated) {
      lastFrameAt = performance.now();
      frame = requestAnimationFrame(tick);
    }
    emit();
  }

  return {
    scene: () => scene,
    elapsed: (of) => times.get(of) ?? 0,
    select(next) {
      scene = next;
      play();
    },
    start() {
      play();
      return stop;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const ScenePlayerContext = createContext<ScenePlayer | null>(null);

/** The scene a player shows. */
export function usePlayerScene(player: ScenePlayer): MockupStateId {
  return useSyncExternalStore(player.subscribe, player.scene, player.scene);
}

/**
 * Reads one fact about a scene at its current time, such as how many tool calls have landed.
 * The component renders again only when that fact changes, so `select` must return a primitive.
 */
export function useSceneClock<Fact extends string | number | boolean>(
  scene: MockupStateId,
  select: (ms: number) => Fact,
): Fact {
  const player = useContext(ScenePlayerContext);
  if (!player) throw new Error("useSceneClock needs a ScenePlayerContext");
  const read = () => select(player.elapsed(scene));
  return useSyncExternalStore(player.subscribe, read, read);
}
