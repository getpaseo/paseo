/** Content fades beneath the header; status overlays render above that fade. */
export const FLOATING_HEADER_FADE_OVERHANG = 48;

export function floatingHeaderOverlayClearance(floating: boolean, headerHeight: number): number {
  return floating ? headerHeight : 0;
}
