import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderConfigState } from "@getpaseo/plugin/server/provider";
import type { AgentOptionControl } from "./agent-sdk-types.js";

/** How a provider session's composer options look to the daemon, whichever shape it reports. */
export interface PluginOptionState {
  controls: AgentOptionControl[];
  /** The values the session runs with, for the keys it reports. */
  options: Record<string, JsonValue>;
  /** The provider reports `settings`, so it also reads `changes.settings`. */
  legacySettings: boolean;
}

/**
 * A provider that reports `controls` and `providerOptions` is read as is.
 * COMPAT(plugin-provider-settings): added in v0.15.0, remove after 2027-05-01. A provider still
 * reporting `settings` has each setting id read as an option key and its value as the option.
 */
export function readPluginOptionState(config: ProviderConfigState): PluginOptionState {
  if (config.controls || config.providerOptions) {
    return {
      controls: (config.controls ?? []).map(toControl),
      options: { ...config.providerOptions },
      legacySettings: false,
    };
  }
  const settings = config.settings ?? [];
  return {
    controls: settings.map(
      (setting): AgentOptionControl =>
        setting.type === "toggle"
          ? {
              type: "toggle",
              key: setting.id,
              label: setting.label,
              ...(setting.description ? { description: setting.description } : {}),
            }
          : {
              type: "select",
              key: setting.id,
              label: setting.label,
              ...(setting.description ? { description: setting.description } : {}),
              choices: setting.options.map((option) => ({
                value: option.value,
                label: option.label,
              })),
            },
    ),
    options: Object.fromEntries(settings.map((setting) => [setting.id, setting.value])),
    legacySettings: true,
  };
}

function toControl(
  control: NonNullable<ProviderConfigState["controls"]>[number],
): AgentOptionControl {
  return control.type === "toggle"
    ? { ...control }
    : { ...control, choices: control.choices.map((choice) => ({ ...choice })) };
}
