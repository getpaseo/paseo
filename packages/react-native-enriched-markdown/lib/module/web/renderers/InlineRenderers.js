"use strict";

import { extractNodeText } from "../utils.js";
import { KaTeXRenderer } from "./KaTeXRenderer.js";
import { linkStyleForUrl } from "../styles.js";
import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
function TextRenderer({
  node
}) {
  return /*#__PURE__*/_jsx(_Fragment, {
    children: node.content ?? ''
  });
}
function LineBreakRenderer(_props) {
  return /*#__PURE__*/_jsx("br", {});
}
function SoftBreakRenderer(_props) {
  return /*#__PURE__*/_jsx(_Fragment, {
    children: " "
  });
}
function StrongRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("strong", {
    style: styles.strong,
    children: renderChildren(node)
  });
}
function EmphasisRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("em", {
    style: styles.emphasis,
    children: renderChildren(node)
  });
}
function StrikethroughRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("s", {
    style: styles.strikethrough,
    children: renderChildren(node)
  });
}
function UnderlineRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("u", {
    style: styles.underline,
    children: renderChildren(node)
  });
}
function SuperscriptRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("sup", {
    style: styles.superscript,
    children: renderChildren(node)
  });
}
function SubscriptRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("sub", {
    style: styles.subscript,
    children: renderChildren(node)
  });
}
function HighlightRenderer({
  node,
  styles,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("mark", {
    style: styles.highlight,
    children: renderChildren(node)
  });
}
function CodeRenderer({
  node,
  styles,
  parentType,
  renderChildren
}) {
  return /*#__PURE__*/_jsx("code", {
    style: parentType === 'Link' ? { ...styles.code, color: 'inherit' } : styles.code,
    children: node.content ?? renderChildren(node)
  });
}
function LinkRenderer({
  node,
  style,
  callbacks,
  capabilities,
  renderChildren
}) {
  const url = node.attributes?.url;
  if (!url) return /*#__PURE__*/_jsx(_Fragment, {
    children: renderChildren(node)
  });
  const isRecognizedLink = node.attributes?.recognizedLink === 'true';
  const containsInlineCode = node.children?.some(child => child.type === 'Code');
  let sourceType = 'markdown';
  if (isRecognizedLink) {
    sourceType = containsInlineCode ? 'inline-code' : 'text';
  }
  const link = { url, sourceType };
  const handleClick = event => {
    if (callbacks.onLinkPress) {
      event.preventDefault();
      callbacks.onLinkPress(link);
    }
  };
  const handleContextMenu = event => {
    if (callbacks.onLinkLongPress) {
      event.preventDefault();
      callbacks.onLinkLongPress({
        url
      });
    }
  };
  const anchorProps = {
    href: url,
    title: node.attributes?.title,
    style: linkStyleForUrl(style, url),
    target: '_blank',
    rel: 'noopener noreferrer',
    onClick: handleClick,
    onContextMenu: handleContextMenu
  };
  const CustomLink = capabilities.renderers?.link;
  if (CustomLink) {
    return /*#__PURE__*/_jsx(CustomLink, {
      link,
      anchorProps,
      children: renderChildren(node)
    });
  }
  return /*#__PURE__*/_jsx("a", { ...anchorProps, children: renderChildren(node) });
}
function LatexMathInlineRenderer({
  node,
  styles,
  capabilities
}) {
  const content = extractNodeText(node);
  return /*#__PURE__*/_jsx(KaTeXRenderer, {
    content: content,
    katex: capabilities.katex,
    displayMode: false,
    style: styles.mathInline
  });
}
export const inlineRenderers = {
  Text: TextRenderer,
  LineBreak: LineBreakRenderer,
  SoftBreak: SoftBreakRenderer,
  Strong: StrongRenderer,
  Emphasis: EmphasisRenderer,
  Strikethrough: StrikethroughRenderer,
  Underline: UnderlineRenderer,
  Superscript: SuperscriptRenderer,
  Subscript: SubscriptRenderer,
  Highlight: HighlightRenderer,
  Code: CodeRenderer,
  Link: LinkRenderer,
  LatexMathInline: LatexMathInlineRenderer
};
//# sourceMappingURL=InlineRenderers.js.map