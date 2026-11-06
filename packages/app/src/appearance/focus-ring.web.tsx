import { useEffect } from "react";
import { withUnistyles } from "react-native-unistyles";

function FocusRing({ color, override }: { color: string; override: string }) {
  useEffect(() => {
    document.documentElement.style.setProperty("--paseo-focus-ring", override || color);
  }, [color, override]);
  return null;
}

// Keep the web-only CSS outline in sync with built-in, system, and plugin themes.
export const AppearanceFocusRing = withUnistyles(FocusRing, (theme) => ({
  color: theme.colors.ring,
}));
