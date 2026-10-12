# Markdown extension example

The smallest plugin that uses every part of `addMarkdownExtension`. Install the directory, then
ask an agent to reply with `::badge::` or a `:::` block.

- `parser` adds two markdown-it rules: an inline `::text::` and a `:::` … `:::` block.
- `rules` render those tokens as ordinary text, so the host assistant row stays in charge of
  copy, selection, and pacing.
- `blockDelimiters` declares the `:::` pair, so the streaming splitter holds a `:::` block that
  has not closed yet in one render block instead of cutting it at the first blank line.

This directory ships no `package.json` and needs none: the callbacks take their `MarkdownIt` and
node types from the SDK contextually, so nothing here imports `markdown-it` or
`react-native-markdown-display`. Name either type explicitly and the plugin compiler requires the
package to resolve, even for a type-only import.
