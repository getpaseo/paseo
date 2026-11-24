"use strict";

import { useMemo } from 'react';
import { jsx as _jsx } from "react/jsx-runtime";
export function KaTeXRenderer({
  content,
  katex,
  displayMode,
  style
}) {
  const delimiter = displayMode ? '$$' : '$';
  const html = useMemo(() => {
    if (!katex) return null;
    return katex.renderToString(content, {
      output: 'mathml',
      displayMode,
      throwOnError: false,
      trust: false
    });
  }, [katex, content, displayMode]);
  const displayStyle = displayMode ? {
    ...style,
    display: 'block',
    whiteSpace: 'pre-wrap'
  } : style;
  if (!html) {
    return /*#__PURE__*/_jsx("span", {
      role: "math",
      "aria-label": content,
      style: displayStyle,
      children: `${delimiter}${content}${delimiter}`
    });
  }
  return /*#__PURE__*/_jsx("span", {
    role: "math",
    "aria-label": content,
    style: displayStyle,
    dangerouslySetInnerHTML: {
      __html: html
    }
  });
}
//# sourceMappingURL=KaTeXRenderer.js.map