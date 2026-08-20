export const WEB_SCROLLBAR_WIDTH = "thin";
export const WEB_SCROLLBAR_SIZE_PX = 8;
export const WEB_SCROLLBAR_RESTING_OPACITY = 0.4;

export function webScrollbarThumbColor(
  handleColor: string,
  opacity = WEB_SCROLLBAR_RESTING_OPACITY,
): string {
  return `color-mix(in srgb, ${handleColor} ${opacity * 100}%, transparent)`;
}

export function webScrollbarColor(handleColor: string): string {
  return `${webScrollbarThumbColor(handleColor)} transparent`;
}
