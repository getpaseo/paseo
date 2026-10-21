# Math timeline plugin example

This plugin typesets LaTeX in assistant messages. It replaces an assistant-message row whose text
contains math with a `math-message` item, and renders that item as text segments plus typeset
formulas.

`shared/math.ts` splits the message into plain-text and math segments using GitHub's delimiters:
`$...$` inline, `$$...$$` display, and the `\(...\)` and `\[...\]` aliases. Code fences and inline
code are copied verbatim, a closing inline `$` cannot be followed by a digit so `$20 ... $30` stays
text, and a delimiter without a closing partner stays text so a streaming `$$` cannot swallow the
rest of the message.

`client/math-markup.tsx` typesets with KaTeX using `output: "mathml"`. MathML needs no stylesheet and
no web fonts, which matters because a plugin has no CSS asset pipeline. The plugin compiler bundles
KaTeX into the client bundle, so a Git install needs the manifest's `build` step
(`npm install --omit=dev`). iOS and Android have no MathML renderer and keep the delimited source.

The compiler produces one client bundle for every platform and does not apply Metro's `.web.tsx`
resolution, so the DOM path lives behind a runtime `Platform.OS === "web"` gate in `client/web.tsx`
rather than a platform file extension.

Messages without math are left untouched: the transformer returns `undefined` and the host renders
them. Messages that do contain math lose the host's markdown rendering for that row, so code fences,
tables and links inside such a message render as plain text.

Install the directory as `math-render`. The plugin has no server entry or subprocess.
