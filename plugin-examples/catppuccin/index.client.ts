import type { PluginClientContext } from "@getpaseo/plugin";

export default function contribute(client: PluginClientContext) {
  client.addTheme({
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      border: "#45475a",
      accent: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
      overrides: {
        surface3: "#585b70",
        foregroundExtraMuted: "#7f849c",
        accentBright: "#f5c2e7",
        destructive: "#f38ba8",
        diffAddition: "#a6e3a1",
        diffDeletion: "#f38ba8",
        statusSuccess: "#a6e3a1",
        statusDanger: "#f38ba8",
        statusWarning: "#f9e2af",
        statusMerged: "#cba6f7",
        terminal: {
          black: "#45475a",
          brightBlack: "#585b70",
        },
      },
    },
  });
  return () => {};
}
