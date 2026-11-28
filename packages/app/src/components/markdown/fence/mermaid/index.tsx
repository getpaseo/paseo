import { createContext, useContext } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { MermaidFenceHost } from "./host";
export { splitMermaidFences } from "./segments";
export const MermaidStreamingContext = createContext(false);
export { MermaidColorsContext } from "./colors-context";
import { MermaidColorsContext } from "./colors-context";
const ThemedHost = withUnistyles(MermaidFenceHost);
const styles = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
export function MermaidFence({ code }: { code: string }) {
  const streaming = useContext(MermaidStreamingContext);
  const options = useContext(MermaidColorsContext);
  return (
    <ThemedHost
      code={code}
      phase={streaming ? "streaming" : "complete"}
      frame={options?.frame}
      uniProps={styles}
    />
  );
}
