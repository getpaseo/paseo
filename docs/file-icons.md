# File Icons

The file explorer uses colored SVG icons from [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) (installed as a dev dependency in `packages/app`).

## How it works

Two files:

- `packages/app/src/components/material-file-icons.ts` — the vendor table. `SVG_ICONS` maps icon
  names to SVG strings copied verbatim from the theme, `EXTENSION_TO_ICON` maps extensions to icon
  names, and `getRawFileIconSvg(fileName)` looks one up with a generic fallback. Keep it a faithful
  copy so re-copying an icon stays a mechanical edit.
- `packages/app/src/components/file-icon-svg.ts` — `getFileIconSvg(fileName)`, the only thing
  anyone should import. It desaturates the vendor colours and caches the result.

Render with `<MaterialFileIcon fileName size />` rather than reaching for `SvgXml` yourself.

## Why the colours are toned down

material-icon-theme picks its palette for VS Code's file tree, where the icon is the only colour on
the row. Ours share rows with status dots, diff stats, and check badges, and a column of them at
full chroma is the loudest thing in the panel.

Every hex in the SVG is pulled toward neutral at the same perceived lightness (`desaturateHexColor`
in `packages/app/src/utils/color.ts`, OKLab — scaling HSL saturation instead would darken the
yellows and barely touch the blues). Hue survives, which is the only part of an icon's colour that
carries meaning at 16pt.

`ICON_CHROMA` in `file-icon-svg.ts` is the single knob. Move it; do not add per-icon overrides, or
we are back to hand-picking 53 colours.

## Adding a new icon

1. Find the icon name in the material-icon-theme manifest:

```bash
node -e "
const m = require('./node_modules/material-icon-theme/dist/material-icons.json');
console.log('fileExtensions:', m.fileExtensions['YOUR_EXT']);
console.log('languageIds:', m.languageIds['YOUR_LANG']);
"
```

2. Verify the SVG exists:

```bash
cat node_modules/material-icon-theme/icons/ICON_NAME.svg
```

3. Add two things to `material-file-icons.ts`:
   - The SVG string in `SVG_ICONS`:

     ```ts
     "icon_name": `<svg ...>...</svg>`,
     ```

   - The extension mapping in `EXTENSION_TO_ICON`:
     ```ts
     "ext": "icon_name",
     ```

4. Run `npm run typecheck` to verify.

## Currently included icons

53 unique icons covering these extensions:

| Extension(s)                               | Icon        |
| ------------------------------------------ | ----------- |
| `ts`                                       | typescript  |
| `tsx`                                      | react_ts    |
| `js`                                       | javascript  |
| `jsx`                                      | react       |
| `py`                                       | python      |
| `go`                                       | go          |
| `rs`                                       | rust        |
| `rb`                                       | ruby        |
| `java`                                     | java        |
| `kt`                                       | kotlin      |
| `c`                                        | c           |
| `cpp`                                      | cpp         |
| `h`                                        | h           |
| `hpp`                                      | hpp         |
| `cs`                                       | csharp      |
| `swift`                                    | swift       |
| `dart`                                     | dart        |
| `ex`, `exs`                                | elixir      |
| `erl`                                      | erlang      |
| `hs`                                       | haskell     |
| `clj`                                      | clojure     |
| `scala`                                    | scala       |
| `ml`                                       | ocaml       |
| `r`                                        | r           |
| `lua`                                      | lua         |
| `zig`                                      | zig         |
| `nix`                                      | nix         |
| `php`                                      | php         |
| `html`                                     | html        |
| `css`                                      | css         |
| `scss`                                     | sass        |
| `less`                                     | less        |
| `json`                                     | json        |
| `yml`, `yaml`                              | yaml        |
| `xml`                                      | xml         |
| `toml`                                     | toml        |
| `md`, `markdown`                           | markdown    |
| `sql`                                      | database    |
| `graphql`, `gql`                           | graphql     |
| `sh`, `bash`                               | console     |
| `tf`                                       | terraform   |
| `hcl`                                      | hcl         |
| `vue`                                      | vue         |
| `svelte`                                   | svelte      |
| `astro`                                    | astro       |
| `wasm`                                     | webassembly |
| `svg`                                      | svg         |
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico` | image       |
| `txt`                                      | document    |
| `conf`, `cfg`, `ini`                       | settings    |
| `lock`                                     | lock        |
| `groovy`                                   | groovy      |
| `gradle`                                   | gradle      |
