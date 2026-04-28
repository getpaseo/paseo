// Test stub for `lucide-react-native`. The real package transitively
// requires `react-native` (Flow syntax in its index.js), which Node's ESM
// loader can't compile. Tests don't actually render icons, so a lazy proxy
// returning a no-op component for any icon name is sufficient.
import { createElement, forwardRef } from "react";

const NoopIcon = forwardRef<unknown, Record<string, unknown>>((props, _ref) =>
  createElement("svg", props as Record<string, unknown>),
);
NoopIcon.displayName = "LucideStub";

export default new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return NoopIcon;
      return NoopIcon;
    },
  },
);
