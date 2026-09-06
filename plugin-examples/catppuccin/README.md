# Catppuccin plugin example

This example adds **Catppuccin Mocha** to Settings → Appearance. Paseo ships Catppuccin as a
syntax-highlight theme; this contributes it as an app theme.

A theme is client data, so the whole plugin is one `addTheme` call in `index.client.ts` and has no
server entry or subprocess.

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

The seed colors come from the [Catppuccin Mocha](https://catppuccin.com/palette/) palette. The
optional semantic overrides keep independent surface, status, diff, and terminal roles on their
authored Catppuccin colors instead of inheriting an unrelated seed. Omit an override to retain
Paseo's compatible seed-derived or dark-family fallback.
