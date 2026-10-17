// Side-effect import: the classic JSX runtime compiles JSX to React.createElement calls, and the
// sidebar module graph evaluates some of them at module scope (menu leading icons), so React has
// to be on the global before those modules execute — import order does that, beforeEach cannot.
import React from "react";

(globalThis as { React?: unknown }).React = React;
