import { useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import type { TerminalPane as TerminalPaneComponent } from "@/components/terminal-pane";

type Pane = typeof TerminalPaneComponent;
type PaneLoad = { component: Pane } | { error: unknown } | null;
let loadedPane: Pane | null = null;

async function loadTerminalPane(): Promise<Pane> {
  if (loadedPane) return loadedPane;
  const { TerminalPane: component } = await import("@/components/terminal-pane");
  loadedPane = component;
  return component;
}

export function preloadTerminalPane() {
  void loadTerminalPane().catch(() => {
    // The mounted pane handles the import failure if it still needs the renderer.
  });
}

const loadingStyle = { flex: 1, alignItems: "center", justifyContent: "center" } as const;
const loadingPlaceholder = (
  <View style={loadingStyle}>
    <ActivityIndicator />
  </View>
);

export function TerminalPane(props: ComponentProps<typeof TerminalPaneComponent>) {
  const [load, setLoad] = useState<PaneLoad>(() => (loadedPane ? { component: loadedPane } : null));

  useEffect(() => {
    if (load) return;
    let mounted = true;
    async function loadPane() {
      try {
        const component = await loadTerminalPane();
        if (mounted) setLoad({ component });
      } catch (error) {
        if (mounted) setLoad({ error });
      }
    }
    void loadPane();
    return () => {
      mounted = false;
    };
  }, [load]);

  if (!load) return loadingPlaceholder;
  if ("error" in load) throw load.error;
  const Component = load.component;
  return <Component {...props} />;
}
