// Two 220-point cards, their gap, and the content padding need room to fit.
export function isNarrowHomePane(width: number): boolean {
  return width < 540;
}
