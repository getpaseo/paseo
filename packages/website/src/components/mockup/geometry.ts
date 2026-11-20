/**
 * The mockup is authored at one fixed size — "design pixels" — and scaled to
 * whatever width its container gives it. Every measurement in the mockup is a
 * plain px number you can reason about directly, and nothing has to change when
 * the hero column gets wider or narrower.
 *
 * The window is 1280 wide, the widest the hero column ever renders it, so on a
 * wide screen one design pixel is one CSS pixel and the text is as large as the
 * app's. The type and control sizes come from measuring public/homepage-hero.png
 * (a 2x capture of a 2249x1289 window region) and dividing by 1.5617.
 */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 734;

export const TITLEBAR_H = 39;
export const TABBAR_H = 31;
export const SIDEBAR_W = 262;
// The docked panel is as wide as the file tree needs. A pull request or a plugin panel gets more room.
export const RIGHT_PANEL_W = 300;
export const RIGHT_PANEL_WIDE_W = 424;
