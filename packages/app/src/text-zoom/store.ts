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

/** The zoom a gesture in progress would apply, shown over the surface until the gesture ends. */
export interface TextZoomPreview {
  readonly surface: TextZoomSurface;
  readonly zoom: number;
}

let zooms: TextZoomState = DEFAULT_TEXT_ZOOM_STATE;
let preview: TextZoomPreview | null = null;
const pinchEnablers: Record<TextZoomSurface, number> = { chat: 0, terminal: 0 };
const listeners = new Set<() => void>();
// A change made before the saved zooms load wins over them.
let changedBeforeHydration = false;

function emit(): void {
  for (const listener of listeners) listener();
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
  const next = clampTextZoom(zoom);
  changedBeforeHydration = true;
  if (zooms[surface] === next) return;
  zooms = { ...zooms, [surface]: next };
  emit();
  void AsyncStorage.setItem(TEXT_ZOOM_STORAGE_KEY, JSON.stringify(zooms)).catch((error) => {
    console.warn("[TextZoom] Failed to save the text zoom", error);
  });
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
      if (preview?.surface === surface) preview = null;
      emit();
    }
  };
}

export function isPinchTextZoomEnabled(surface: TextZoomSurface): boolean {
  return pinchEnablers[surface] > 0;
}

export function setTextZoomPreview(next: TextZoomPreview | null): void {
  if (preview?.surface === next?.surface && preview?.zoom === next?.zoom) return;
  preview = next;
  emit();
}

export function getTextZoomPreview(): TextZoomPreview | null {
  return preview;
}

/** Loads the saved zooms. Runs once at startup; a zoom set before it finishes is kept. */
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
  if (saved.chat === zooms.chat && saved.terminal === zooms.terminal) return;
  zooms = saved;
  emit();
}

/** Test seam: forget the in-memory state, as a fresh launch would. */
export function resetTextZoomForTests(): void {
  zooms = DEFAULT_TEXT_ZOOM_STATE;
  preview = null;
  pinchEnablers.chat = 0;
  pinchEnablers.terminal = 0;
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

/** The zoom a gesture on this surface is previewing, or null when none is in progress. */
export function useTextZoomPreview(surface: TextZoomSurface): number | null {
  const read = () => (preview?.surface === surface ? preview.zoom : null);
  return useSyncExternalStore(subscribeTextZoom, read, read);
}
