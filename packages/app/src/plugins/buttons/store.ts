import { resolvePluginIcon } from "../icons";
import { PluginButtonStore } from "./model";

export const pluginButtonStore = new PluginButtonStore({ validateIconName: resolvePluginIcon });
