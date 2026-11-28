// Apply the interface (UI) font app-wide on web.
//
// react-native-web stamps a hardcoded default font onto every text element, so a
// plain `body { font-family }` never cascades in — the element already has its own
// font. Instead we inject ONE rule that points all text at a CSS variable and set
// that variable live. The selector is high-specificity (1,2,0) so it deterministically
// beats both RN-web's base font and Unistyles' generated classes (0,1,0) — no reliance
// on stylesheet order. Code/diff/terminal surfaces carry `data-pmono` (and have their
// subtree excluded via `:not([data-pmono] *)`) so they keep their monospace font.
//
// The rule carries the default stack as the `var()` fallback. A `font-family` that
// references an unset custom property is invalid at computed-value time and inherits
// instead, and the inherited chain ends at Chromium's initial family — Times New Roman
// on Windows. That is the serif desktop UI this fallback rules out: the rule keeps
// rendering the sans stack even before the first appearance apply, after a
// `documentElement` style reset, or if the variable is dropped by anything else.
import { DEFAULT_UI_FONT_STACK } from "@/styles/theme";

const STYLE_ID = "paseo-ui-font";

/** The injected rule. Exported so a test can pin the fallback stack. */
export function buildRootUiFontRule(fallbackStack: string): string {
  // The stack goes into a `var()` fallback, which ends at the first unbalanced `)`.
  // The default stack is a plain comma list, but a caller may pass anything.
  const safeFallback = fallbackStack
    .replace(/[<>{};()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = safeFallback.length > 0 ? `,${safeFallback}` : "";
  return `:is(#root, #overlay-root) *:not([data-pmono]):not([data-pmono] *){font-family:var(--paseo-ui-font${fallback});}`;
}

export function applyRootUiFont(uiFontStack: string): void {
  if (typeof document === "undefined") return;
  // Strip anything that could break out of the CSS value; commas/quotes/spaces in a
  // font stack are fine.
  const value = uiFontStack
    .replace(/[<>{}();]/g, "")
    .replace(/[\r\n]/g, " ")
    .trim();
  if (value.length === 0) return;

  document.documentElement.style.setProperty("--paseo-ui-font", value);

  // The rule is static (it references the variable and falls back to the default
  // stack); inject it once.
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildRootUiFontRule(DEFAULT_UI_FONT_STACK);
    document.head.appendChild(style);
  }
}
