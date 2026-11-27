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
  /**
   * Plays the opening scene from the start, unless a scene has played already. A pill click can
   * come before the page decides to start, and that scene keeps its place.
   */
  start(): void;
  /** Stops the clock. A scene that is playing holds its last frame. */
  stop(): void;
  subscribe(listener: () => void): () => void;
}

// A background tab stops animation frames. On return the script resumes where it paused.
const LONGEST_FRAME_MS = 64;

/** What the player needs from the page to keep time. Tests pass a clock they turn by hand. */
export interface Frames {
  now(): number;
  request(callback: (now: number) => void): number;
  cancel(id: number): void;
  reducedMotion(): boolean;
}

const browserFrames: Frames = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
  // Visitors who ask for reduced motion get the finished scene.
  reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

/**
 * @param durations How long each scene's script runs. A scene without a script has no entry and is
 * always at its finished state.
 */
export function createScenePlayer(
  initial: MockupStateId,
  durations: Partial<Record<MockupStateId, number>>,
  frames: Frames = browserFrames,
): ScenePlayer {
  let scene = initial;
  const times = new Map<MockupStateId, number>();
  const listeners = new Set<() => void>();
  let frame = 0;
  let lastFrameAt = 0;
  let played = false;

  function emit() {
    for (const listener of listeners) listener();
  }

  function stop() {
    if (frame) frames.cancel(frame);
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
    frame = next < end ? frames.request(tick) : 0;
    emit();
  }

  function play() {
    played = true;
    stop();
    const end = durations[scene] ?? 0;
    const animated = end > 0 && !frames.reducedMotion();
    times.set(scene, animated ? 0 : end);
    if (animated) {
      lastFrameAt = frames.now();
      frame = frames.request(tick);
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
      if (!played) play();
    },
    stop,
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
