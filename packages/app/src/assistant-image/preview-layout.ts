const RESULT_IMAGE_VIEWPORT_FRACTION = 0.45;
const RESULT_IMAGE_FALLBACK_HEIGHT = 160;

export interface AssistantImagePreviewLayoutInput {
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  aspectRatio?: number;
  containerWidth: number;
  viewportHeight: number;
}

export interface AssistantImagePreviewSize {
  width: number;
  height: number;
}

export function fitAssistantImagePreview(
  input: AssistantImagePreviewLayoutInput,
): AssistantImagePreviewSize {
  const aspectRatio =
    input.intrinsicWidth &&
    input.intrinsicWidth > 0 &&
    input.intrinsicHeight &&
    input.intrinsicHeight > 0
      ? input.intrinsicWidth / input.intrinsicHeight
      : input.aspectRatio;
  if (
    !aspectRatio ||
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0 ||
    !Number.isFinite(input.containerWidth) ||
    input.containerWidth <= 0 ||
    !Number.isFinite(input.viewportHeight) ||
    input.viewportHeight <= 0
  ) {
    return { width: Math.max(0, input.containerWidth), height: RESULT_IMAGE_FALLBACK_HEIGHT };
  }

  const intrinsicWidth = input.intrinsicWidth ?? input.containerWidth;
  const maxHeight = input.viewportHeight * RESULT_IMAGE_VIEWPORT_FRACTION;
  const width = Math.min(intrinsicWidth, input.containerWidth, maxHeight * aspectRatio);
  return {
    width: Math.round(width),
    height: Math.round(width / aspectRatio),
  };
}
