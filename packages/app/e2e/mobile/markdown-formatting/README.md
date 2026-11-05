# Inline code formatting

This fixture renders the production `MarkdownRenderer` with plain, bold, italic,
combined emphasis, strikethrough and linked code, plus bold code in headings,
lists and quotes. Toggle regular/compact text. Inline code uses the theme’s
code-to-body size ratio at every heading level; fenced code keeps the code-size
token. Bold and links preserve the resulting size. Check the glyphs, not the background height: native backgrounds use
line metrics.

Use a development client rebuilt from this checkout. Follow the temporary entry
point and Metro workflow in [status-ring](../status-ring/README.md), importing
`MarkdownFormattingRegression` from `./e2e/mobile/markdown-formatting/native`.
Open the same Metro URL in a browser to compare web. Restore `index.ts` afterward.

With this fixture open in an Android Agent Device session, run:

```sh
node packages/app/e2e/mobile/markdown-formatting/android.mjs <session>
```

The runner switches to paragraphs with long inline code at a fixed 300 dp width.
It compares the native Markdown host’s bottom with its last TextView’s bottom,
then repeats in compact mode and after restoring regular text. More than one
pixel of surplus fails. Keep the whole fixture visible: clipped accessibility
bounds cannot establish measurement parity.

`scripts/postinstall-patches.test.mjs` regenerates both platforms’ props and
compares them with the shipped headers. This catches missing C++ fields in the
measurement path, which the Kotlin tests cannot exercise.

The package patch contains `InlineCodeFormattingTest`, which exercises actual
Android spans in Robolectric native graphics mode, covering draw and measurement,
span order, code inside paragraph/heading sizes, bold/italic composition, and
links preserving code and emphasized prose fonts.
It runs in the existing `test:android` CI job. To run only this regression locally,
from `packages/app/android` after Expo prebuild:

```sh
./gradlew :react-native-enriched-markdown:testDebugUnitTest \
  --tests '*InlineCodeFormattingTest' --no-daemon --max-workers=2
```
