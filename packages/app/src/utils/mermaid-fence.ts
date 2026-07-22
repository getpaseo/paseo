export function isMermaidFence(info: string | null | undefined): boolean {
  return info?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

// Mermaid can fetch external resources while *rendering* — image shapes
// (`A@{ img: "url" }`) construct an Image and await decode before any output
// sanitization runs, and CSS can pull url()/@import — so a prompt-injected
// diagram could exfiltrate data in a request URL. securityLevel "strict" does
// not prevent this (mermaid-js/mermaid#7645). Mermaid 11.16 parses the shape
// metadata object with yaml.JSON_SCHEMA semantics, including aliases and
// explicit keys; matching those keys safely would require a real parser. We
// therefore reject any `@{ ... }` shape-data construct up front and fall back
// to the source code block. `<br>` is allowed because it is idiomatic in
// mermaid labels; all other tags (and entity-encoded text that could smuggle
// one) are rejected.
const UNSAFE_MERMAID_SOURCE = /@\s*\{|url\s*\(|@import\b|themeCSS|&#|<(?!br\s*\/?>)[a-z!/]/i;

// Mermaid labels can contain escaped text. Decode the escape forms we care
// about before running the denylist so disguised HTML still gets caught.
// Invalid escape sequences fail closed and fall back to the source block.
function normalizeMermaidSource(code: string): string | null {
  try {
    return code
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) =>
        decodeCodePointEscape(Number.parseInt(hex, 16)),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/["'`\\]/g, "");
  } catch {
    return null;
  }
}

function decodeCodePointEscape(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    throw new RangeError("Invalid Unicode code point");
  }
  return String.fromCodePoint(value);
}

export function containsUnsafeMermaidSource(code: string): boolean {
  if (UNSAFE_MERMAID_SOURCE.test(code)) {
    return true;
  }
  const normalized = normalizeMermaidSource(code);
  if (normalized === null) {
    return true;
  }
  return UNSAFE_MERMAID_SOURCE.test(normalized);
}
