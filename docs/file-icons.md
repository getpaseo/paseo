# File Icons

The file explorer uses colored SVG icons from [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) (installed as a dev dependency in `packages/app`).

Icons are inlined as SVG strings in:

```
packages/app/src/components/material-file-icons.ts
```

This file is auto-generated. Do not edit it by hand.

## How it works

- `SVG_ICONS` maps icon names (e.g. `"typescript"`) to raw SVG strings
- `EXTENSION_TO_ICON` maps file extensions (e.g. `"ts"`) to icon names
- `getFileIconSvg(fileName)` returns the SVG string for a given filename, falling back to a generic file icon
- `packages/app/src/components/file-explorer-pane.tsx` is the only consumer; it renders the SVG with `SvgXml` from `react-native-svg`

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
