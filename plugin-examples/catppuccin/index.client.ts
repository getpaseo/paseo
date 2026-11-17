import type { PluginClientContext } from "@getpaseo/plugin/client";

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
      sidebar: "#181825",
      sidebarHover: "#313244",
      sidebarSelected: "#45475a",
      surface3: "#45475a",
      surface4: "#585b70",
      foregroundExtraMuted: "#7f849c",
    },
  });
  return () => {};
}
