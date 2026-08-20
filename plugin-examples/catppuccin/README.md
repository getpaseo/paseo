# Catppuccin plugin example

This example adds **Catppuccin Mocha** to Settings → Appearance. Paseo ships Catppuccin as a
syntax-highlight theme; this contributes it as an app theme.

A theme is data, so the whole plugin is one `addTheme` call in `index.ts` — no client file, no RPC.

Register it in `$PASEO_HOME/config.json`:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "catppuccin": {
      "source": "directory",
      "path": "/absolute/path/to/paseo/plugin-examples/catppuccin"
    }
  }
}
```

Then run `paseo reload` and pick **Catppuccin Mocha** in Settings → Appearance.

The colors come straight from the [Catppuccin Mocha](https://catppuccin.com/palette/) palette:
`base`, `text`, `surface0`, `surface1`, `mauve`, `subtext0`, and `overlay0`. Paseo expands them
into the full token set, so `highlight` (`mauve`) drives buttons and selection while `accent`
(`surface1`, shared with `control`) stays the border and raised-surface tint.
