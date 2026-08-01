export interface ContainedPanBoundsInput {
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
}

export interface PanBounds {
  x: number;
  y: number;
}

export interface FocalTranslationInput {
  startTranslation: number;
  startFocal: number;
  focal: number;
  scaleRatio: number;
}

export function getContainedPanBounds(input: ContainedPanBoundsInput): PanBounds {
  "worklet";
  if (
    input.viewportWidth <= 0 ||
    input.viewportHeight <= 0 ||
    input.imageWidth <= 0 ||
    input.imageHeight <= 0
  ) {
    return { x: 0, y: 0 };
  }

  const fitScale = Math.min(
    input.viewportWidth / input.imageWidth,
    input.viewportHeight / input.imageHeight,
  );
  const renderedWidth = input.imageWidth * fitScale;
  const renderedHeight = input.imageHeight * fitScale;
  return {
    x: Math.max(0, renderedWidth * input.scale - input.viewportWidth) / 2,
    y: Math.max(0, renderedHeight * input.scale - input.viewportHeight) / 2,
  };
}

export function getFocalTranslation(input: FocalTranslationInput): number {
  "worklet";
  return input.focal + input.scaleRatio * (input.startTranslation - input.startFocal);
}
