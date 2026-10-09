import MarkdownIt from "markdown-it";

/**
 * The one place that decides how the app parses markdown.
 *
 * `typographer` stays off. It switches on two markdown-it core rules that
 * rewrite characters the user may copy back into a shell or a file:
 * `replacements` turns `(c)` into ©, `a -- b` into an en dash and `...` into
 * an ellipsis, and `smartquotes` curls straight quotes so `--name="x"` stops
 * being pasteable. Agent output, plans and file previews all have to render
 * the text they were handed.
 *
 * `linkify` is a parameter rather than a shared default because the surfaces
 * disagree today: chat and the default renderer linkify bare URLs, plan cards
 * never have. Unifying that is a product decision on its own.
 */
export function createMarkdownParser({ linkify }: { linkify: boolean }): MarkdownIt {
  return new MarkdownIt({ html: false, linkify });
}
