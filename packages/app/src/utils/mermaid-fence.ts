export function isMermaidFence(info: string | null | undefined): boolean {
  return info?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

// Mermaid can fetch external resources while *rendering* — image shapes
// (`A@{ img: "url" }`) construct an Image and await decode before any output
// sanitization runs, and CSS can pull url()/@import — so a prompt-injected
// diagram could exfiltrate data in a request URL. securityLevel "strict" does
// not prevent this (mermaid-js/mermaid#7645). Reject resource-bearing
// constructs up front; matches fall back to the source code block. `<br>` is
// allowed because it is idiomatic in mermaid labels; all other tags (and
// entity-encoded text that could smuggle one) are rejected.
const UNSAFE_MERMAID_SOURCE =
  /\bimg\s*:|\bicon\s*:|url\s*\(|@import\b|themeCSS|&#|<(?!br\s*\/?>)[a-z!/]/i;

// Mermaid accepts quoted and unicode-escaped object keys (`"img":`,
// `"img":`), which the raw regex would miss. Decode escapes and strip
// quoting characters so the denylist sees the same keys mermaid's parser
// ultimately produces, and test the raw source too.
function normalizeMermaidSource(code: string): string {
  return code
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/["'`\\]/g, "");
}

export function containsUnsafeMermaidSource(code: string): boolean {
  return (
    UNSAFE_MERMAID_SOURCE.test(code) || UNSAFE_MERMAID_SOURCE.test(normalizeMermaidSource(code))
  );
}
