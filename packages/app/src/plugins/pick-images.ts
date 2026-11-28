import type { PluginPickedImage } from "@getpaseo/plugin/client";
import type {
  PickedImageAttachmentInput,
  PickedImageSource,
} from "@/hooks/image-attachment-picker";

interface PickImagesDeps {
  pick: () => Promise<PickedImageAttachmentInput[] | null>;
  readBase64: (source: PickedImageSource) => Promise<string>;
  signal: AbortSignal;
}

/** The composer's image picker for plugins, with each image read into base64. */
export function createPickImages(deps: PickImagesDeps) {
  return async (): Promise<PluginPickedImage[]> => {
    if (deps.signal.aborted) throw new Error("Plugin has stopped");
    const picked = await deps.pick();
    if (!picked?.length) return [];
    const images = await Promise.all(
      picked.map(async (image) => ({
        name: image.fileName ?? null,
        mimeType: image.mimeType,
        base64: await deps.readBase64(image.source),
      })),
    );
    if (deps.signal.aborted) throw new Error("Plugin has stopped");
    return images;
  };
}
