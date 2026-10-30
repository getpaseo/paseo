import type { PluginSerializableIcon } from "../icons.js";

/** A presentation-only provider icon replacement on this plugin installation's host. */
export interface PluginProviderIconOverrideContribution {
  /** Unique within the plugin. The returned cleanup removes this contribution. */
  id: string;
  /** Exact provider ID, including built-in or plugin-provided providers. */
  provider: string;
  /** Lucide icon name or self-contained SVG markup; component icons are not accepted. */
  icon: PluginSerializableIcon;
}
