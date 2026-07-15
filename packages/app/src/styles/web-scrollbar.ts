export const WEB_SCROLLBAR_WIDTH = "thin";
export const WEB_SCROLLBAR_SIZE_PX = 8;

export function webScrollbarThumbColor(handleColor: string): string {
  return `color-mix(in srgb, ${handleColor} 62%, transparent)`;
}

export function webScrollbarColor(handleColor: string): string {
  return `${webScrollbarThumbColor(handleColor)} transparent`;
}
