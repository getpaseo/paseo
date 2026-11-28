import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRootUiFontRule } from "./apply-root-font.web";

const STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

describe("buildRootUiFontRule", () => {
  it("keeps pointing app text at the live variable", () => {
    const rule = buildRootUiFontRule(STACK);
    expect(rule).toContain(":is(#root, #overlay-root) *:not([data-pmono]):not([data-pmono] *)");
    expect(rule).toContain(`font-family:var(--paseo-ui-font,${STACK});`);
  });

  it("carries the stack as the var() fallback so an unset variable never resolves to serif", () => {
    // A `var()` reference with no fallback is invalid at computed-value time, so the
    // declaration inherits and the chain ends at Chromium's initial family — Times New
    // Roman on Windows. That is the reported serif desktop UI.
    expect(buildRootUiFontRule(STACK)).not.toContain("var(--paseo-ui-font)");
  });

  it("drops characters that would break out of the fallback", () => {
    expect(buildRootUiFontRule("Inter; } body{ (x)")).toBe(
      ":is(#root, #overlay-root) *:not([data-pmono]):not([data-pmono] *){font-family:var(--paseo-ui-font,Inter body x);}",
    );
  });
});

describe("web shell template", () => {
  // The renderer paints before appearance settings hydrate, and some DOM (noscript,
  // injected overlays) sits outside `#root`; both inherit the shell font.
  it("gives html/body the sans stack so nothing falls back to Times New Roman", () => {
    const html = readFileSync(path.join(__dirname, "../../public/index.html"), "utf8");
    const start = html.indexOf('<style id="expo-reset">');
    const resetBlock = html.slice(start, html.indexOf("</style>", start));
    expect(resetBlock).toMatch(/html,\s*body\s*\{[\s\S]*font-family:\s*system-ui/);
    expect(resetBlock).toContain('"Segoe UI"');
  });
});
