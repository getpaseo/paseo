export const pluginSettingsPrefix = ["plugin-settings"] as const;
export const pluginSettingsKey = (id: string) => [...pluginSettingsPrefix, id] as const;
