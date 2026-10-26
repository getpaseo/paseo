# Native text selection

Keep completed assistant prose in one native text view so selection crosses paragraphs, headings and lists. The shared [Markdown renderer](markdown-renderer.md) owns that view.

## Android inverted chat

Keep selection visibility handling in `modules/paseo-scroll`. Android's visibility
rectangles ignore list inversion. React Native decomposes Android's `scale: -1`
into rotation with positive `scaleY`, so test the composed matrix when deciding
whether those requests should move the viewport. Native tests must apply the
list's transform through React Native's view manager; assigning `scaleY` directly
misses that decomposition.

## Diagrams in lists and quotes

Selection stops at a Mermaid diagram. Native extracts Mermaid fences into separate views because the library exposes no native block renderer override. A diagram inside a list or quote therefore appears outside that container, and its following prose starts a separate Markdown fragment.

Reopening a list marker or quote prefix on the following fragment cannot place the diagram inside the original container or continue its quote rule. Preserving the group requires a native block renderer hook or a host that owns the whole group. Keep native diagrams at the top level until that exists; nested grouping remains a known limitation.

## Leading inline images

Native image decoders do not support SVG badges, so the renderer shows their alt text. Pending images share the web placeholder: a reserved image box with a small centred image glyph; confirmed acquisition or decoding failures show alt text.

The native library classifies an image from the text preceding it. A raster image at the start of a paragraph uses block sizing even when text follows; the inline size setting only affects images the library recognizes as inline. Correcting that classification requires a native library change and new app builds. JavaScript-only updates retain that classification until native app builds include a library fix.
