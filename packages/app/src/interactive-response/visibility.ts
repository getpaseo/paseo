import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";

export function useArtifactActive(): boolean {
  const panelActive = useRetainedPanelActive();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return panelActive && foreground;
}
