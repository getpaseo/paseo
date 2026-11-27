import { useMemo, useSyncExternalStore } from "react";
import {
  AttachmentLightbox,
  type ImageLightboxPaging,
  type ImageLightboxSource,
} from "@/components/attachment-lightbox";
import { pluginImagePreviewStore } from "./store";

/**
 * Mounts the viewer opened with `openImagePreview`. It is the host's own lightbox, so a plugin
 * gets pinch and wheel zoom, Escape, Android Back, and the overlay layer model without drawing
 * any of it; the store keeps the images and the current index.
 */
export function PluginImagePreviewHost() {
  const state = useSyncExternalStore(
    pluginImagePreviewStore.subscribe,
    pluginImagePreviewStore.getSnapshot,
    pluginImagePreviewStore.getSnapshot,
  );
  const current = state?.images[state.index];
  const source = useMemo<ImageLightboxSource | null>(
    () => (current ? { type: "uri", uri: current.uri } : null),
    [current],
  );
  const paging = useMemo<ImageLightboxPaging | undefined>(
    () =>
      state
        ? {
            index: state.index,
            count: state.images.length,
            onSelect: pluginImagePreviewStore.select,
          }
        : undefined,
    [state],
  );
  return (
    <AttachmentLightbox
      source={source}
      onClose={pluginImagePreviewStore.close}
      title={current?.name}
      paging={paging}
    />
  );
}
