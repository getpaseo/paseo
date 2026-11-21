import { Image } from "react-native";
import type { ViewportSize } from "./geometry";

/** Resolves the image's natural size; rejects when the image cannot load or has no size. */
export function measureImage(uri: string): Promise<ViewportSize> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => {
        if (width > 0 && height > 0) resolve({ width, height });
        else reject(new Error("Image has no size"));
      },
      reject,
    );
  });
}
