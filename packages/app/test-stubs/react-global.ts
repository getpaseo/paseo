import React from "react";

// The vitest transform emits classic-runtime JSX (React.createElement) while the
// app's babel config uses the automatic runtime. Components that omit the React
// import (e.g. the shared terminal panel) must see a React global when they
// evaluate in tests.
(globalThis as { React?: typeof React }).React = React;

// Re-exported so importers satisfy no-unassigned-import while the side effect
// above runs first (this module is imported before any panel module).
export const reactGlobalInstalled = true;
