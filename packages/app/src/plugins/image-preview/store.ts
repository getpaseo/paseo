import type { ImagePreviewItem, ImagePreviewOptions } from "@getpaseo/plugin/client/react-native";

export interface PluginImagePreviewState {
  images: readonly ImagePreviewItem[];
  index: number;
}

function clampIndex(index: number | undefined, count: number): number {
  if (typeof index !== "number" || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

function isPreviewItem(value: unknown): value is ImagePreviewItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { uri?: unknown }).uri === "string" &&
    (value as { uri: string }).uri.length > 0
  );
}

/**
 * The image preview opened with `openImagePreview`. One at a time: a second call replaces the
 * first, since two full-window viewers stacked would leave the user closing the wrong one. The
 * host renders it at the app root, above the plugin's own `Overlay`, so the plugin surface that
 * opened it can keep rendering as it was.
 */
export function createPluginImagePreviewStore() {
  let state: PluginImagePreviewState | null = null;
  const listeners = new Set<() => void>();

  function publish(next: PluginImagePreviewState | null): void {
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): PluginImagePreviewState | null {
      return state;
    },
    open(options: ImagePreviewOptions): void {
      const images = Array.isArray(options?.images) ? options.images.filter(isPreviewItem) : [];
      if (images.length === 0) throw new Error("Image preview needs at least one image with a uri");
      // Copy the entries so a plugin mutating its array later cannot move the viewer.
      publish({
        images: images.map((image) => ({
          uri: image.uri,
          ...(typeof image.name === "string" ? { name: image.name } : {}),
        })),
        index: clampIndex(options.index, images.length),
      });
    },
    select(index: number): void {
      if (!state) return;
      const next = clampIndex(index, state.images.length);
      if (next !== state.index) publish({ ...state, index: next });
    },
    close(): void {
      if (state) publish(null);
    },
  };
}

export const pluginImagePreviewStore = createPluginImagePreviewStore();
