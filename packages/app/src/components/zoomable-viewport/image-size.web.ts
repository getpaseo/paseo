import type { ViewportSize } from "./geometry";

// The size a browser gives a replaced element that has no intrinsic size of its own.
const NO_INTRINSIC_SIZE: ViewportSize = { width: 300, height: 150 };

/**
 * Resolves the image's natural size; rejects when the image cannot load. React Native Web's
 * `Image.getSize` never answers for an image that loads with no natural size (an SVG without
 * width and height, in some browsers), so the image would never show and never fail.
 */
export function measureImage(uri: string): Promise<ViewportSize> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.addEventListener("load", () =>
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : NO_INTRINSIC_SIZE,
      ),
    );
    image.addEventListener("error", () => reject(new Error("Image failed to load")));
    image.src = uri;
  });
}
