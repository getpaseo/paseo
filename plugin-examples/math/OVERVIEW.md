Typesets LaTeX in assistant messages, so formulas arrive as formulas instead of `$$...$$` source.

It reads each assistant message as it arrives and splits it into plain text and math. Messages
without math are left exactly as Paseo renders them. Messages with math are drawn by the plugin
instead: text segments in the timeline's normal colour, formulas typeset by KaTeX.

Delimiters follow GitHub: `$...$` inline, `$$...$$` display, plus `\(...\)` and `\[...\]`. Formulas
inside code fences or inline code are left as code, currency such as `$20 ... $30` stays text, and an
unfinished delimiter stays text while a message is still streaming.

Web and Electron typeset the formula. iOS and Android show the delimited source, since Paseo has no
TeX typesetter on those platforms.

Known limit: a message that contains math is drawn by the plugin, so other markdown in that same
message (code fences, tables, links) appears as plain text.
