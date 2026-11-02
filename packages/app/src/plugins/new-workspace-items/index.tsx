import { useMemo } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { PluginNewWorkspaceProvider } from "@getpaseo/plugin/client/host";
import { withUnistyles } from "react-native-unistyles";
import {
  ComposerControlLockProvider,
  ComposerControlSurfaceProvider,
} from "@/composer/agent-controls/composer-control";
import type { PickerItem } from "@/screens/new-workspace-picker-item";
import {
  useNewWorkspaceSetupState,
  type NewWorkspaceSetup,
} from "@/screens/new-workspace/setup-model";
import { PluginItemList, pluginThemeMapping, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { toPluginNewWorkspace } from "./model";

/** What the screen derives and the items read; the rest is in the setup model. */
export interface NewWorkspaceItemsScreen {
  project: { id: string; name: string } | null;
  isolation: "local" | "worktree";
  baseItem: PickerItem | null;
  locked: boolean;
}

function useServerPlugins(serverId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      installed.filter(
        (plugin) => plugin.serverId === serverId && plugin.newWorkspaceItems.length > 0,
      ),
    [installed, serverId],
  );
}

/**
 * The selected host's plugin items on the New workspace screen, drawn as setup fields. They read
 * the screen's choices and command them through the setup model.
 */
export function PluginNewWorkspaceItems({
  serverId,
  screen,
  setup,
}: {
  serverId: string;
  screen: NewWorkspaceItemsScreen;
  setup: NewWorkspaceSetup;
}) {
  const plugins = useServerPlugins(serverId);
  return (
    <ComposerControlSurfaceProvider value="field">
      <ComposerControlLockProvider value={screen.locked}>
        {plugins.map((plugin) => (
          <ThemedPluginNewWorkspaceItems
            key={plugin.id}
            plugin={plugin}
            screen={screen}
            setup={setup}
            uniProps={pluginThemeMapping}
          />
        ))}
      </ComposerControlLockProvider>
    </ComposerControlSurfaceProvider>
  );
}

function PluginNewWorkspaceItemsHost({
  plugin,
  theme,
  screen,
  setup,
}: {
  plugin: InstalledPlugin;
  theme: PluginHostProps["theme"];
  screen: NewWorkspaceItemsScreen;
  setup: NewWorkspaceSetup;
}) {
  const { environment, props } = usePluginItemHost(plugin, theme);
  const { branch, metadata } = useNewWorkspaceSetupState(setup);
  const newWorkspace = useMemo(
    () =>
      toPluginNewWorkspace({
        host: props.host,
        view: { ...screen, branch, metadata },
        commands: setup.commands,
      }),
    [branch, metadata, props.host, screen, setup.commands],
  );
  return (
    <PluginEnvironmentProvider environment={environment}>
      <PluginNewWorkspaceProvider newWorkspace={newWorkspace}>
        <PluginItemList plugin={plugin} items={plugin.newWorkspaceItems} props={props} />
      </PluginNewWorkspaceProvider>
    </PluginEnvironmentProvider>
  );
}

const ThemedPluginNewWorkspaceItems = withUnistyles(PluginNewWorkspaceItemsHost);
