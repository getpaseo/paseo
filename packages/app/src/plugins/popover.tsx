import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuSurface, type MenuSurfaceProps } from "@/components/ui/menu";
import { ToastApiProvider, type useToast } from "@/contexts/toast-context";
import type { createPluginClientStateSource } from "./client-state/source";
import { PluginInstallationProvider } from "./installation-provider";
import type { InstalledPlugin } from "./types";

export interface PluginEnvironment {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  toast: ReturnType<typeof useToast>;
}

interface PluginEnvironmentProviderProps {
  environment: PluginEnvironment;
  children: ReactNode;
}

/**
 * The providers plugin UI runs under. Render it around a contribution and again inside every
 * surface it opens: native sheets teleport their children, so providers around the trigger alone
 * cannot reach a popover body.
 */
export function PluginEnvironmentProvider({
  environment,
  children,
}: PluginEnvironmentProviderProps) {
  return (
    <ToastApiProvider api={environment.toast}>
      <PluginInstallationProvider plugin={environment.installation}>
        <PluginClientStateProvider source={environment.state}>{children}</PluginClientStateProvider>
      </PluginInstallationProvider>
    </ToastApiProvider>
  );
}

type PluginPopoverSurfaceProps = Pick<
  MenuSurfaceProps,
  | "children"
  | "pages"
  | "sheetTitle"
  | "sheetTrailing"
  | "side"
  | "align"
  | "offset"
  | "testID"
  | "minWidth"
  | "maxWidth"
>;

/**
 * The surface every plugin popover opens in: anchored to its trigger on wide layouts, a bottom
 * sheet on compact ones when the enclosing `MenuRoot` uses `compactMode="sheet"`.
 */
export function PluginPopoverSurface({
  minWidth = 280,
  maxWidth = 420,
  ...props
}: PluginPopoverSurfaceProps) {
  return (
    <MenuSurface {...props} minWidth={minWidth} maxWidth={maxWidth} maxHeight={440} scrollable />
  );
}

export function PluginPopoverContent({ children }: { children: ReactNode }) {
  return <View style={styles.content}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
}));
