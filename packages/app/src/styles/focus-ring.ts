// Markers for the app-wide web focus ring (public/index.html), which is drawn
// inside the control's own box. On native they render nothing. Use the shared
// stable references so they don't trip the react-perf "new object as prop" rule.

// Controls whose content reaches the edge of their box, like text links and the
// switch track. An inner ring would cover that content, so they get the ring
// just outside the box instead.
export const OUTER_FOCUS_RING_DATASET = { focusRing: "outer" } as const;

// Controls filled with the accent or destructive color, or surfaces with that
// fill whose controls sit on it. The ring would vanish against the fill, so it
// gets a surface-colored band on its inner side.
export const FILLED_FOCUS_RING_DATASET = { focusRing: "filled" } as const;
