import { parsePluginIcon } from "../icons";
import { PluginButtonStore } from "./model";

export const pluginButtonStore = new PluginButtonStore({
  parseIcon: (icon) => parsePluginIcon("Plugin button", icon),
});
