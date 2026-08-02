export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 4;
export const IMAGE_ZOOM_STEP = 0.25;

export interface ImagePreviewSize {
  width: number;
  height: number;
}

export interface ImagePreviewPoint {
  x: number;
  y: number;
}

export interface ImagePreviewTransform {
  zoom: number;
  x: number;
  y: number;
}

export const FIT_IMAGE_TRANSFORM: ImagePreviewTransform = {
  zoom: MIN_IMAGE_ZOOM,
  x: 0,
  y: 0,
};

export function fitImageSize(
  image: ImagePreviewSize,
  viewport: ImagePreviewSize,
): ImagePreviewSize {
  const fitScale = Math.min(viewport.width / image.width, viewport.height / image.height);
  return {
    width: image.width * fitScale,
    height: image.height * fitScale,
  };
}

export function clampImageZoom(zoom: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom));
}

export function clampImageTransform(
  transform: ImagePreviewTransform,
  fittedImage: ImagePreviewSize,
  viewport: ImagePreviewSize,
): ImagePreviewTransform {
  const zoom = clampImageZoom(transform.zoom);
  if (zoom === MIN_IMAGE_ZOOM) {
    return FIT_IMAGE_TRANSFORM;
  }

  const maxX = Math.max(0, (fittedImage.width * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (fittedImage.height * zoom - viewport.height) / 2);
  return {
    zoom,
    x: Math.min(maxX, Math.max(-maxX, transform.x)),
    y: Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

export function zoomImageAtPoint(input: {
  transform: ImagePreviewTransform;
  zoom: number;
  focalPoint: ImagePreviewPoint;
  fittedImage: ImagePreviewSize;
  viewport: ImagePreviewSize;
}): ImagePreviewTransform {
  const zoom = clampImageZoom(input.zoom);
  if (zoom === MIN_IMAGE_ZOOM) {
    return FIT_IMAGE_TRANSFORM;
  }

  const viewportCenter = {
    x: input.viewport.width / 2,
    y: input.viewport.height / 2,
  };
  const imagePoint = {
    x: (input.focalPoint.x - viewportCenter.x - input.transform.x) / input.transform.zoom,
    y: (input.focalPoint.y - viewportCenter.y - input.transform.y) / input.transform.zoom,
  };

  return clampImageTransform(
    {
      zoom,
      x: input.focalPoint.x - viewportCenter.x - imagePoint.x * zoom,
      y: input.focalPoint.y - viewportCenter.y - imagePoint.y * zoom,
    },
    input.fittedImage,
    input.viewport,
  );
}

export function panImage(input: {
  transform: ImagePreviewTransform;
  delta: ImagePreviewPoint;
  fittedImage: ImagePreviewSize;
  viewport: ImagePreviewSize;
}): ImagePreviewTransform {
  return clampImageTransform(
    {
      ...input.transform,
      x: input.transform.x + input.delta.x,
      y: input.transform.y + input.delta.y,
    },
    input.fittedImage,
    input.viewport,
  );
}
