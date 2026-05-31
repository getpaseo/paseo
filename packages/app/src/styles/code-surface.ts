// Marker for code / diff / monospace surfaces. On web, the app-wide interface-font
// rule (see screens/settings/appearance/apply-root-font.web.ts) targets
// `#root *:not([data-pmono]):not([data-pmono] *)`, so tagging a code container with
// this dataSet excludes it and its subtree — they keep their monospace font. On
// native it renders nothing and is harmless. Use a shared stable reference so it
// doesn't trip the react-perf "new object as prop" rule.
export const CODE_SURFACE_DATASET = { pmono: "" } as const;
