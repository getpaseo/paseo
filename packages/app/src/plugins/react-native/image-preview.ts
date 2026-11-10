import type { ImagePreviewOptions } from "@getpaseo/plugin/client/react-native";
import { pluginImagePreviewStore } from "../image-preview/store";

/** The host's lightbox, mounted at the app root by `PluginImagePreviewHost`. */
export function openImagePreview(options: ImagePreviewOptions): void {
  pluginImagePreviewStore.open(options);
}
