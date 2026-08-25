# 文件图标

文件浏览器使用来自 [`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) 的彩色 SVG 图标（作为 `packages/app` 中的开发依赖安装）。

图标以内联 SVG 字符串的形式存在：

```
packages/app/src/components/material-file-icons.ts
```

此文件是自动生成的。不要手动编辑它。

## 工作原理

- `SVG_ICONS` 将图标名称（例如 `"typescript"`）映射到原始 SVG 字符串
- `EXTENSION_TO_ICON` 将文件扩展名（例如 `"ts"`）映射到图标名称
- `getFileIconSvg(fileName)` 返回给定文件名的 SVG 字符串，回退到通用文件图标
- `packages/app/src/components/file-explorer-pane.tsx` 是唯一的消费者；它使用 `react-native-svg` 的 `SvgXml` 渲染 SVG

## 添加新图标

1. 在 material-icon-theme 清单中查找图标名称：

```bash
node -e "
const m = require('./node_modules/material-icon-theme/dist/material-icons.json');
console.log('fileExtensions:', m.fileExtensions['YOUR_EXT']);
console.log('languageIds:', m.languageIds['YOUR_LANG']);
"
```

2. 验证 SVG 存在：

```bash
cat node_modules/material-icon-theme/icons/ICON_NAME.svg
```

3. 向 `material-file-icons.ts` 添加两项内容：
   - `SVG_ICONS` 中的 SVG 字符串：

     ```ts
     "icon_name": `<svg ...>...</svg>`,
     ```

   - `EXTENSION_TO_ICON` 中的扩展名映射：
     ```ts
     "ext": "icon_name",
     ```

4. 运行 `npm run typecheck` 验证。

## 当前包含的图标

53 个独特图标，覆盖以下扩展名：

| 扩展名                                       | 图标        |
| -------------------------------------------- | ----------- |
| `ts`                                         | typescript  |
| `tsx`                                        | react_ts    |
| `js`                                         | javascript  |
| `jsx`                                        | react       |
| `py`                                         | python      |
| `go`                                         | go          |
| `rs`                                         | rust        |
| `rb`                                         | ruby        |
| `java`                                       | java        |
| `kt`                                         | kotlin      |
| `c`                                          | c           |
| `cpp`                                        | cpp         |
| `h`                                          | h           |
| `hpp`                                        | hpp         |
| `cs`                                         | csharp      |
| `swift`                                      | swift       |
| `dart`                                       | dart        |
| `ex`, `exs`                                  | elixir      |
| `erl`                                        | erlang      |
| `hs`                                         | haskell     |
| `clj`                                        | clojure     |
| `scala`                                      | scala       |
| `ml`                                         | ocaml       |
| `r`                                          | r           |
| `lua`                                        | lua         |
| `zig`                                        | zig         |
| `nix`                                        | nix         |
| `php`                                        | php         |
| `html`                                       | html        |
| `css`                                        | css         |
| `scss`                                       | sass        |
| `less`                                       | less        |
| `json`                                       | json        |
| `yml`, `yaml`                                | yaml        |
| `xml`                                        | xml         |
| `toml`                                       | toml        |
| `md`, `markdown`                             | markdown    |
| `sql`                                        | database    |
| `graphql`, `gql`                             | graphql     |
| `sh`, `bash`                                 | console     |
| `tf`                                         | terraform   |
| `hcl`                                        | hcl         |
| `vue`                                        | vue         |
| `svelte`                                     | svelte      |
| `astro`                                      | astro       |
| `wasm`                                       | webassembly |
| `svg`                                        | svg         |
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`   | image       |
| `txt`                                        | document    |
| `conf`, `cfg`, `ini`                         | settings    |
| `lock`                                       | lock        |
| `groovy`                                     | groovy      |
| `gradle`                                     | gradle      |
