# Brand assets

Canonical marks, lockups, and wordmark font for **Paseo** and **Paseo Hub**. These are the source assets for the icons across the app, desktop client, website, docs, and Hub.

## Brand architecture

- **Paseo** (butterfly mark): the local client, daemon, CLI, SDK, and small account features (sign-in, share links, tunnels).
- **Paseo Hub** (flower mark): the software factory, team features, hosted service, and paid plans (`Hub Free`, `Hub Solo`, `Hub Team`).
- **Hub** (flower mark + `Hub`): used only where Paseo is already on screen, such as inside the Hub dashboard header.

## Specifications

### Marks

Both marks are single-line stroked paths on a `700 × 700` viewBox with `stroke-width="50"`, `stroke-linecap="round"`, and `stroke-linejoin="round"`. Both are optically centered to a `527`-unit ink footprint:

- **Paseo (`marks/paseo-*.svg`)**: refit of the hand-drawn butterfly (redraw B) with smooth curvature on the large wing and lower loop and a uniform `50` stroke width.
- **Paseo Hub (`marks/paseo-hub-*.svg`)**: five-petal looped flower (variant A) with a `12°` clockwise petal lean, sized up to match the butterfly's `527` footprint with the same `50` stroke.

Colors:

- `white` (`#FFFFFF`) for dark surfaces (`#101615`, `#101010`, `#000000`)
- `black` (`#000000`) for light surfaces
- `green` (`#20744A`) brand accent

### Lockups

All lockups (`lockups/*.svg`) share a `144`-unit height (`140`-unit flower ink height with a `2`-unit margin on all sides) so stacked lockups align cleanly:

- **Font**: Plus Jakarta Sans SemiBold (`600`), bundled in `fonts/PlusJakartaSans-SemiBold.ttf` under the SIL Open Font License 1.1 (`fonts/OFL.txt`).
- **Outlined text**: lockup SVGs outline the wordmark to `<path>` elements so they render identically everywhere without the font installed.
- **Proportions**: marks are `15%` larger against text and `20%` closer than the original website header baseline (`24 px` box, `12 px` gap, `18 px` text).
- **Optical balance**: in the `paseo` lockup, the butterfly is scaled to `94%` (`stroke-width` proportional) so `Paseo`, `Paseo Hub`, and `Hub` sit at equal visual weight when shown together.

## Files

```text
assets/brand/
  build.mjs                     Regenerates all marks and lockups
  build-app-icons.mjs           Regenerates the desktop and mobile app icons
  app-icons/
    paseo-lit.png
    paseo-dev-lit.png
  fonts/
    PlusJakartaSans-SemiBold.ttf
    OFL.txt
  marks/
    paseo-white.svg
    paseo-black.svg
    paseo-green.svg
    paseo-hub-white.svg
    paseo-hub-black.svg
    paseo-hub-green.svg
  lockups/
    paseo-white.svg
    paseo-black.svg
    paseo-hub-white.svg
    paseo-hub-black.svg
    hub-white.svg
    hub-black.svg
```

## Regenerate

```sh
node assets/brand/build.mjs
```

## App icons

`build-app-icons.mjs` renders every desktop and mobile app icon from `marks/paseo-white.svg`: the white butterfly on a black tile, and a blueprint tile for desktop development builds. Regenerate them after changing the butterfly:

```sh
node assets/brand/build-app-icons.mjs
```

The icons that ship are flat. Each platform masks and lights its own icons, so lit artwork ends up lit twice. `app-icons/` keeps a lit version of the two desktop icons, a baked approximation of macOS Liquid Glass. Nothing uses them.

The packaged Mac app takes its icon from `packages/desktop/assets/icon.icon`, an Icon Composer document the script also writes. macOS draws Liquid Glass on it and derives the dark, tinted, and clear variants. electron-builder compiles the document with `actool`, so packaging the Mac app needs Xcode 26 or later. The Nix build has no Xcode and uses `icon.icns`.

To see what macOS draws from the document without packaging the app, export it with Icon Composer's command line tool on a Mac:

```sh
"/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool" \
  packages/desktop/assets/icon.icon --export-image --output-file icon.png \
  --platform macOS --rendition Default --width 1024 --height 1024 --scale 1
```

`--rendition` also takes `Dark`, `TintedLight`, `TintedDark`, `ClearLight`, and `ClearDark`.
