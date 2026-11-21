## Contribute a theme

`addTheme` takes a small light or dark palette; Paseo expands it into the full token set. Every color is a hex string.

```ts
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
  },
});
```

It appears under Settings → Appearance. A client that predates `addTheme` cannot evaluate the entry and reports `client.addTheme is not a function`; update the client. See `plugin-examples/catppuccin`.
