// On web the interface font is forced onto every element (appearance/apply-root-font.web.ts), so
// text that deliberately uses the display serif or the mono face carries one of these markers.
// Shared references keep the react-perf "new object as prop" rule quiet; on native they render nothing.
export const DISPLAY_FONT_DATASET = { pfont: "display" } as const;
export const MONO_FONT_DATASET = { pfont: "mono" } as const;
