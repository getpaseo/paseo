import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import {
  DEFAULT_TEXT_ZOOM,
  DEFAULT_TEXT_ZOOM_STATE,
  clampTextZoom,
  parseStoredTextZoom,
  type TextZoomState,
  type TextZoomSurface,
} from "./model";

export const TEXT_ZOOM_STORAGE_KEY = "@paseo:text-zoom";

/** A point in window coordinates: the page on web, the app window on native. */
export interface TextZoomPoint {
  readonly x: number;
  readonly y: number;
}

/** A pinch in progress. Its surface's zoom changes live; it is saved when the pinch ends. */
export interface TextZoomPinch {
  readonly surface: TextZoomSurface;
  /** Where the fingers started, so views can keep the content under them in place. */
  readonly focal: TextZoomPoint | null;
}

let zooms: TextZoomState = DEFAULT_TEXT_ZOOM_STATE;
let pinch: TextZoomPinch | null = null;
const pinchEnablers: Record<TextZoomSurface, number> = { chat: 0, terminal: 0, files: 0 };
const listeners = new Set<() => void>();
// A change made before the saved zooms load wins over them.
let changedBeforeHydration = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function save(): void {
  void AsyncStorage.setItem(TEXT_ZOOM_STORAGE_KEY, JSON.stringify(zooms)).catch((error) => {
    console.warn("[TextZoom] Failed to save the text zoom", error);
  });
}

/** Changes one surface only; the others keep their value. */
function writeZoom(surface: TextZoomSurface, zoom: number): boolean {
  const next = clampTextZoom(zoom);
  changedBeforeHydration = true;
  if (zooms[surface] === next) return false;
  zooms = { ...zooms, [surface]: next };
  emit();
  return true;
}

export function subscribeTextZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTextZoom(surface: TextZoomSurface): number {
  return zooms[surface];
}

/** Sets a surface's zoom and saves it on this device. 1 returns the surface to its settings size. */
export function setTextZoom(surface: TextZoomSurface, zoom: number): void {
  if (writeZoom(surface, zoom)) save();
}

/** Starts a pinch on a surface. Its zoom then follows `applyPinchTextZoom` until it ends. */
export function beginTextZoomPinch(surface: TextZoomSurface, focal: TextZoomPoint | null): void {
  pinch = { surface, focal };
  changedBeforeHydration = true;
  emit();
}

/** Records the focal point once the area has measured where it is in the window. */
export function setTextZoomPinchFocal(focal: TextZoomPoint): void {
  if (!pinch) return;
  pinch = { ...pinch, focal };
}

/** A live step of the pinch in progress: the views re-lay out now, nothing is saved yet. */
export function applyPinchTextZoom(zoom: number): void {
  if (pinch) writeZoom(pinch.surface, zoom);
}

/** Ends the pinch and saves the zoom it reached, once. */
export function endTextZoomPinch(): void {
  if (!pinch) return;
  pinch = null;
  save();
  emit();
}

export function getTextZoomPinch(): TextZoomPinch | null {
  return pinch;
}

/**
 * Turns on pinch-to-zoom for a surface until the returned function runs. Every caller has its
 * own claim, so one plugin stopping does not turn off another's.
 */
export function enablePinchTextZoom(surface: TextZoomSurface): () => void {
  pinchEnablers[surface] += 1;
  if (pinchEnablers[surface] === 1) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pinchEnablers[surface] -= 1;
    if (pinchEnablers[surface] === 0) {
      if (pinch?.surface === surface) endTextZoomPinch();
      emit();
    }
  };
}

export function isPinchTextZoomEnabled(surface: TextZoomSurface): boolean {
  return pinchEnablers[surface] > 0;
}

/** Loads the saved zooms. Runs once at startup; a zoom changed before it finishes is kept. */
export async function hydrateTextZoom(): Promise<void> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(TEXT_ZOOM_STORAGE_KEY);
  } catch (error) {
    console.warn("[TextZoom] Failed to load the text zoom", error);
    return;
  }
  if (changedBeforeHydration) return;
  const saved = parseStoredTextZoom(raw);
  if (
    saved.chat === zooms.chat &&
    saved.terminal === zooms.terminal &&
    saved.files === zooms.files
  ) {
    return;
  }
  zooms = saved;
  emit();
}

/** Test seam: forget the in-memory state, as a fresh launch would. */
export function resetTextZoomForTests(): void {
  zooms = DEFAULT_TEXT_ZOOM_STATE;
  pinch = null;
  pinchEnablers.chat = 0;
  pinchEnablers.terminal = 0;
  pinchEnablers.files = 0;
  changedBeforeHydration = false;
  listeners.clear();
}

/** A surface's zoom, live. `null` is outside every zoomable surface and always 1. */
export function useTextZoom(surface: TextZoomSurface | null): number {
  const read = () => (surface ? zooms[surface] : DEFAULT_TEXT_ZOOM);
  return useSyncExternalStore(subscribeTextZoom, read, read);
}

export function usePinchTextZoomEnabled(surface: TextZoomSurface): boolean {
  const read = () => isPinchTextZoomEnabled(surface);
  return useSyncExternalStore(subscribeTextZoom, read, read);
}

/** True while a pinch on this surface is in progress. */
export function useTextZoomPinching(surface: TextZoomSurface): boolean {
  const read = () => pinch?.surface === surface;
  return useSyncExternalStore(subscribeTextZoom, read, read);
}
