import MarkdownIt from "markdown-it";
import { parseInlinePathToken } from "@/utils/inline-path";

export function createAssistantMarkdownIt() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });

  const escapeHtml: (value: string) => string = md.utils.escapeHtml;

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens: any, idx: number, options: any, env: any, self: any) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (
    tokens: any,
    idx: number,
    options: any,
    env: any,
    self: any
  ) => {
    const token = tokens[idx];

    const targetIndex = token.attrIndex("target");
    if (targetIndex < 0) {
      token.attrPush(["target", "_blank"]);
    } else {
      token.attrs[targetIndex][1] = "_blank";
    }

    const relIndex = token.attrIndex("rel");
    const relValue = "noopener noreferrer";
    if (relIndex < 0) {
      token.attrPush(["rel", relValue]);
    } else {
      token.attrs[relIndex][1] = relValue;
    }

    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.code_inline = (tokens: any, idx: number) => {
    const content = tokens[idx]?.content ?? "";
    const parsed = parseInlinePathToken(content);

    if (parsed) {
      const escaped = escapeHtml(content);
      const escapedAttr = escapeHtml(content);
      return `<span class="paseo-path-chip" data-inline-path="${escapedAttr}">${escaped}</span>`;
    }

    return `<code class="paseo-inline-code">${escapeHtml(content)}</code>`;
  };

  md.renderer.rules.table_open = () =>
    '<div class="paseo-table-wrapper"><table class="paseo-table">';
  md.renderer.rules.table_close = () => "</table></div>";

  const renderFence = (token: any) => {
    const info = (token.info ?? "").trim();
    const lang = info ? info.split(/\s+/)[0] : "";
    const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
    const code = escapeHtml(token.content ?? "");
    return `<pre class="paseo-code-block"><code class="paseo-code${langClass}">${code}</code></pre>`;
  };

  md.renderer.rules.fence = (tokens: any, idx: number) => renderFence(tokens[idx]);
  md.renderer.rules.code_block = (tokens: any, idx: number) =>
    renderFence({ content: tokens[idx]?.content ?? "", info: "" });

  return md;
}

export function renderAssistantMarkdownHtml(markdown: string) {
  const md = createAssistantMarkdownIt();
  return md.render(markdown ?? "");
}

