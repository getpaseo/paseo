<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/b1efabc5-37df-4ddc-8fbb-6f587fdcb5e6">
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/eb844f3b-4b63-4327-bf5e-569e4573dedc">
  <img alt="Enriched Markdown by Software Mansion" src="https://github.com/user-attachments/assets/b1efabc5-37df-4ddc-8fbb-6f587fdcb5e6">
</picture>
<a href="https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-react-native-enriched-1&n=1"><img src="https://swm-delivery.com/www/images/zone-gh-react-native-enriched-1?n=1" /></a>
<a href="https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-react-native-enriched-2&n=1"><img src="https://swm-delivery.com/www/images/zone-gh-react-native-enriched-2?n=1" /></a>
<a href="https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-react-native-enriched-3&n=1"><img src="https://swm-delivery.com/www/images/zone-gh-react-native-enriched-3?n=1" /></a>

# react-native-enriched-markdown

`react-native-enriched-markdown` is a powerful React Native library that renders Markdown content as native text and provides a rich text input with Markdown output. It supports iOS, Android, macOS, and Web, and requires the New Architecture (Fabric) for native platforms.

### EnrichedMarkdownText

- ⚡ Fully native text rendering (no WebView)
- 🌐 Web support via [react-native-web](https://necolas.github.io/react-native-web/) + [md4c](https://github.com/mity/md4c) compiled to WebAssembly
- 🎯 High-performance Markdown parsing with [md4c](https://github.com/mity/md4c)
- 📐 CommonMark standard compliant
- 📊 GitHub Flavored Markdown (GFM)
- 🧮 LaTeX math rendering (block `$$...$$` with `flavor="github"`, inline `$...$` in all flavors)
- 🔀 [Markdown Streaming](../../docs-md/MARKDOWN_STREAMING.md) support (via [react-native-streamdown](https://github.com/software-mansion-labs/react-native-streamdown))
- 🎨 Fully customizable styles for all elements
- ✨ Text selection and copy support
- 📌 Custom text selection context menu items
- 🔗 Interactive link handling with [per-URL-pattern styling](../../docs-md/MENTIONS.md#link-variants-styling) (`linkVariants`)
- 💊 [Native link pills](../../docs-md/MENTIONS.md#native-link-pills) — links as rounded chips with an icon and label, per URL pattern or per link (iOS, Android)
- 📎 [Long-press menus for links](../../docs-md/API_REFERENCE.md#linkcontextmenuitems) with your own items per URL pattern (`linkContextMenuItems`, iOS 17+)
- 👤 Renders mentions as styled links (compatible with `EnrichedMarkdownTextInput` mention output)
- 🙈 Spoiler text with animated particle overlay and tap-to-reveal
- 🖼️ Native image interactions (iOS: Copy, Save to Camera Roll)
- 🎬 Native video playback — block-level videos via HTML `<video>` tag
- 🌐 Native platform features (Translate, Look Up, Search Web, Share)
- 🗣️ Accessibility support (VoiceOver on iOS, TalkBack on Android, semantic HTML on web)
- 🔄 Full RTL (right-to-left) support including text, lists, blockquotes, tables, and task lists

### EnrichedMarkdownTextInput

- ✏️ Rich text input with Markdown output
- 🕹️ Imperative API for toggling styles and managing links
- 📋 Native context menu with formatting submenu
- 🔍 Real-time style state detection
- 🔗 Auto-link detection with customizable regex
- 🔄 Smart copy/paste with Markdown preservation
- 🎨 Customizable bold, italic, and link colors
- 👤 [Mentions](../../docs-md/MENTIONS.md) with configurable indicators, suggestion lifecycle events, and per-pattern link styling

Since 2012 [Software Mansion](https://swmansion.com) is a software agency with experience in building web and mobile apps. We are Core React Native Contributors and experts in dealing with all kinds of React Native issues.
We can help you build your next dream product –
[Hire us](https://swmansion.com/contact/projects?utm_source=react-native-enriched-markdown&utm_medium=readme).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Native assets (install-time download)](../../docs-md/NATIVE_ASSETS.md)
- [EnrichedMarkdownText](#enrichedmarkdowntext-1)
  - [Usage](../../docs-md/TEXT.md#usage)
  - [Supported Markdown Elements](../../docs-md/TEXT.md#supported-markdown-elements)
  - [Copy Options](../../docs-md/TEXT.md#copy-options)
  - [Accessibility](../../docs-md/TEXT.md#accessibility)
  - [RTL Support](../../docs-md/TEXT.md#rtl-support)
  - [Customizing Styles](../../docs-md/TEXT.md#customizing-styles)
  - [LaTeX Math](../../docs-md/LATEX_MATH.md)
  - [Image Caching](../../docs-md/IMAGE_CACHING.md)
  - [Markdown Streaming](../../docs-md/MARKDOWN_STREAMING.md)
- [EnrichedMarkdownTextInput](#enrichedmarkdowntextinput-1)
  - [Usage](../../docs-md/INPUT.md#usage)
  - [Inline Styles](../../docs-md/INPUT.md#inline-styles)
  - [Links](../../docs-md/INPUT.md#links)
  - [Auto-Link Detection](../../docs-md/INPUT.md#auto-link-detection)
  - [Mentions](../../docs-md/MENTIONS.md)
  - [Style Detection](../../docs-md/INPUT.md#style-detection)
  - [Other Events](../../docs-md/INPUT.md#other-events)
  - [Customizing Styles](../../docs-md/INPUT.md#customizing-enrichedmarkdowntextinput--styles)
- [API Reference](#api-reference)
- [Testing with Jest](../../docs-md/TESTING.md)
- [Web Support](../../docs-md/WEB.md)
- [macOS Support](../../docs-md/MACOS.md)
- [Compatibility Table](#compatibility-table)
- [Contributing](#contributing)
- [Future Plans](#future-plans)
- [License](#license)

## Prerequisites

**Native (iOS / Android / macOS)**

- Requires [the React Native New Architecture (Fabric)](https://reactnative.dev/architecture/landing-page)
- See [Compatibility Table](#compatibility-table) for supported React Native versions
- macOS support via [react-native-macos](https://github.com/microsoft/react-native-macos) `0.81+`

**Web**

- Requires [`react-native-web`](https://necolas.github.io/react-native-web/) and Metro (or another bundler with `.web.tsx` platform resolution)
- No New Architecture requirement — the web renderer runs entirely in JavaScript via WebAssembly
- Only `EnrichedMarkdownText` is supported on web (`EnrichedMarkdownTextInput` is native-only)
- LaTeX math requires the optional [`katex`](https://katex.org/) peer dependency

## Installation

### Web

No steps beyond having `react-native-web` configured. For LaTeX math, install the optional peer dependency:

```sh
npm install katex
# or
yarn add katex
```

See [Web Support](../../docs-md/WEB.md) for full setup details, supported features, and prop behaviour.

### Bare React Native app (iOS / Android)

#### 1. Install the library

```sh
yarn add react-native-enriched-markdown
```

> [!TIP]
> To try the latest features before they land in a stable release, install the nightly build:
>
> ```sh
> yarn add react-native-enriched-markdown@nightly
> ```
>
> Nightly versions are published to npm automatically and may contain breaking changes.

> [!NOTE]
> On install, a `postinstall` script downloads the large native assets used by code highlighting
> and iOS LaTeX math (kept out of the npm tarball to keep it ~1 MB). This needs network access to
> `registry.npmjs.org` and `github.com`. If you install offline, with `--ignore-scripts`, or with
> **pnpm** (which blocks dependency scripts by default), see
> [Native assets](../../docs-md/NATIVE_ASSETS.md) for how to restore them.

#### Configuration

Add an `"enriched-markdown"` block to your app's `package.json` to configure which features are enabled:

```json
{
  "enriched-markdown": {
    "enableCodeHighlight": true,
    "enableMath": true,
    "enableVideo": true,
    "codeHighlightLanguages": ["javascript", "typescript", "python", "swift", "kotlin"]
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `enableCodeHighlight` | `boolean` | `true` | Download and compile tree-sitter grammars for syntax highlighting |
| `enableMath` | `boolean` | `true` | Download [RaTeX](https://ratex.lites.dev/) for LaTeX math rendering (iOS) and include the Maven dependency (Android) |
| `enableVideo` | `boolean` | `true` | Enable native video playback. Adds Media3 ExoPlayer (~2-3 MB) on Android; uses built-in AVKit on iOS. Set to `false` to exclude the dependency |
| `codeHighlightLanguages` | `string[]` | all default grammars | Subset of languages to compile (reduces binary size). Ignored when `enableCodeHighlight` is `false`; an empty array `[]` compiles none (same as disabling). |

Your app's `package.json` is the single source of truth. `postinstall` reads it to decide
what to **download** into `node_modules`, and the native build (iOS podspec / Android
`build.gradle`) reads it directly to decide what to **compile and link** — no Podfile ENV
vars or `gradle.properties` edits needed. Changing a value takes effect on your next
`pod install` / native rebuild; **enabling** a feature that was off also needs a reinstall
(`npm install` / `npm rebuild react-native-enriched-markdown`) so its assets get downloaded.

> [!IMPORTANT]
> **iOS applies config at `pod install`, not at build time.** After editing the `enriched-markdown`
> block, run `pod install` (a plain `run-ios` reuses the previously resolved pod). When **disabling** a
> feature that was already compiled in — or narrowing `codeHighlightLanguages` — also do a clean build
> (`Product > Clean Build Folder`), since Xcode's incremental build can link a stale pod library.
> Android reconfigures on every build and needs neither step.

> [!TIP]
> If you don't use a feature, disabling it skips the download **and** excludes it from the native build.
> See [Skipping the download](../../docs-md/NATIVE_ASSETS.md#skipping-the-download-opt-out) for details.

> [!NOTE]
> **Monorepos:** the native build reads the **app's** `package.json` (the one next to
> `ios/`/`android/`), so each app can enable/disable features independently. The download
> opt-out is resolved where you run the install — usually the workspace root — so to skip a
> download entirely, put the opt-out in the **root** `package.json`.

> [!NOTE]
> Migrating from the Expo config plugin or the `ENV` / `gradle.properties` build flags? See
> [Breaking changes](../../docs-md/BREAKING_CHANGES.md).

#### 2. Install iOS / macOS dependencies

The library includes native code so you will need to re-build the native app.

```sh
# iOS
cd ios && bundle install && bundle exec pod install

# macOS (react-native-macos)
cd macos && bundle install && bundle exec pod install
```

### Expo app

#### 1. Install the library

```sh
npx expo install react-native-enriched-markdown
```

#### 2. Run prebuild

The library includes native code so you will need to re-build the native app.

```sh
npx expo prebuild
```

> [!NOTE]
> The library won't work in Expo Go as it needs native changes.

> [!NOTE]
> `npx expo install` runs the same `postinstall` asset download described under
> [Native assets](../../docs-md/NATIVE_ASSETS.md); it needs network access and does not work with Yarn PnP.

> [!IMPORTANT]
> **iOS: Save to Camera Roll**
>
> If your Markdown content includes images and you want users to save them to their photo library, add the following to your `Info.plist`:
>
> ```xml
> <key>NSPhotoLibraryAddUsageDescription</key>
> <string>This app needs access to your photo library to save images.</string>
> ```

## EnrichedMarkdownText

See [EnrichedMarkdownText](../../docs-md/TEXT.md) for detailed documentation on usage examples, GFM tables, task lists, link handling, supported elements, copy options, accessibility, RTL support, and customizing styles. Mentions created by `EnrichedMarkdownTextInput` render as styled links — use [`linkVariants`](../../docs-md/MENTIONS.md#link-variants-styling) to customize their appearance.

## EnrichedMarkdownTextInput

See [EnrichedMarkdownTextInput](../../docs-md/INPUT.md) for detailed documentation on usage examples, inline styles, links, style detection, events, and customizing styles.

## API Reference

See the [API Reference](../../docs-md/API_REFERENCE.md) for a detailed overview of all the props, methods, and events available.

## Web Support

See [Web Support](../../docs-md/WEB.md) for details on supported features, web-specific prop behaviour, and known limitations.

## macOS Support

`react-native-enriched-markdown` supports macOS via [react-native-macos](https://github.com/microsoft/react-native-macos). See [macOS Support](../../docs-md/MACOS.md) for details on macOS-specific features, known limitations, and the example app.

## Future Plans

We're actively working on expanding the capabilities of `react-native-enriched-markdown`. Here's what's on the roadmap:

- `EnrichedMarkdownTextInput`: headings, lists, blockquotes, code blocks, inline images
- `EnrichedMarkdownTextInput` web support
- macOS: block math rendering, VoiceOver accessibility, tail fade-in animation
- Web: spoiler text, streaming animation, configurable link `target`, copy options (Copy as Markdown, multi-format clipboard)

## Compatibility Table

|             | 0.82 | 0.83 | 0.84 | 0.85 | 0.86 | 0.87 |
| ----------- | :--: | :--: | :--: | :--: | :--: | :--: |
| **nightly** |  ⛔  |  ✅  |  ✅  |  ✅  |  ✅  |  ✅  |
| **1.1.x**   |  ⛔  |  ✅  |  ✅  |  ✅  |  ✅  |  ✅  |
| **1.0.x**   |  ⛔  |  ✅  |  ✅  |  ✅  |  ✅  |  ✅  |
| **0.7.0**   |  ⛔  |  ✅  |  ✅  |  ✅  |  ✅  |  ✅  |
| **0.6.0**   |  ⛔  |  ✅  |  ✅  |  ✅  |  ⛔  |  ⛔  |
| **0.5.0**   |  ⛔  |  ✅  |  ✅  |  ✅  |  ⛔  |  ⛔  |
| **0.4.x**   |  ✅  |  ✅  |  ✅  |  ⛔  |  ⛔  |  ⛔  |
| **0.3.0**   |  ✅  |  ✅  |  ✅  |  ⛔  |  ⛔  |  ⛔  |

## Contributing

See the [contributing guide](../../CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

`react-native-enriched-markdown` library is licensed under [The MIT License](../../LICENSE).

---

Built by [Software Mansion](https://swmansion.com/).

[<img width="128" height="69" alt="Software Mansion Logo" src="https://github.com/user-attachments/assets/f0e18471-a7aa-4e80-86ac-87686a86fe56" />](https://swmansion.com/)
