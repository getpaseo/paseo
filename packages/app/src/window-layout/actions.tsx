import type { ReactNode } from "react";
import { Portal, PortalHost } from "@gorhom/portal";
import { StyleSheet, View } from "react-native";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement } from "./model";

const HOST = "window-layout-actions";

export function WindowLayoutActionsHost() {
  return <PortalHost name={HOST} />;
}

/** The native bar guide is in window coordinates, so the host lives at the window root. */
export function WindowLayoutActions({
  children,
  active,
}: {
  children: ReactNode;
  active: boolean;
}) {
  const layout = useWindowLayout();
  if (resolveWorkspaceActionPlacement(layout) !== "vertical-bar" || !layout?.verticalBar) {
    return null;
  }
  const bar = layout.verticalBar;
  return (
    <Portal hostName={HOST}>
      <View
        testID="workspace-vertical-actions"
        style={[
          styles.bar,
          { left: bar.x, top: bar.y, width: bar.width, height: bar.height },
          !active && styles.hidden,
        ]}
        pointerEvents="box-none"
      >
        <RetainedPanelActivity active={active}>
          <IconButtonChromeProvider value="header-island">{children}</IconButtonChromeProvider>
        </RetainedPanelActivity>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
  bar: { position: "absolute", alignItems: "center", gap: 8 },
});
