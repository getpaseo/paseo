import { Image } from "expo-image";
import type { ViewportSize } from "./geometry";

/**
 * Resolves the image's natural size; rejects when the image cannot load or has no size. Decodes
 * with Expo Image, the same decoder that draws the image: React Native's `Image.getSize` cannot
 * decode SVG on Android or iOS.
 */
export async function measureImage(uri: string): Promise<ViewportSize> {
  const { width, height } = await Image.loadAsync(uri);
  if (width > 0 && height > 0) return { width, height };
  throw new Error("Image has no size");
}
