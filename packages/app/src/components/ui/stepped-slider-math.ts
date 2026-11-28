/**
 * Pure geometry for `SteppedSlider`: maps between discrete stop indices and normalized track
 * positions so tap targets, pan scrubbing, and visual stops agree to the pixel.
 */

export function resolveSliderFraction(index: number, count: number): number {
  if (count <= 1) return 0;
  return clamp(index, 0, count - 1) / (count - 1);
}

export function resolveSliderIndexFromX(x: number, trackWidth: number, count: number): number {
  if (count <= 1 || trackWidth <= 0) return 0;
  const fraction = clamp(x / trackWidth, 0, 1);
  return Math.round(fraction * (count - 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
