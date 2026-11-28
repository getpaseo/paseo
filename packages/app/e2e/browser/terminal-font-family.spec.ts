import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

const CODE_FONT = "monospace";
const INTERFACE_FONT = "serif";

test("terminal text keeps the code font when an interface font is set", async ({ page }) => {
  // Without WebGL2 the terminal falls back to xterm's DOM renderer, whose rows are
  // styled by CSS and so can inherit the interface font.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === "webgl2") return null;
      return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof getContext;
  });
  await page.addInitScript(
    (fonts) => {
      const saved = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ ...saved, ...fonts }));
    },
    { monoFontFamily: CODE_FONT, uiFontFamily: INTERFACE_FONT },
  );

  const harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-font-family-" });
  try {
    await withTerminalInApp(page, harness, { name: "font-family" }, async () => {
      await harness.setupPrompt(page);
      await harness
        .terminalSurface(page)
        .pressSequentially("clear; printf 'iiiiiiiiii\\nWWWWWWWWWW\\n'\n", { delay: 0 });
      await waitForTerminalContent(page, (text) => text.includes("WWWWWWWWWW"), 10_000);

      await harness
        .terminalSurface(page)
        .screenshot({ path: test.info().outputPath("terminal-font-family.png") });

      const rowFont = await page
        .locator(".xterm-rows")
        .evaluate((rows) => getComputedStyle(rows).fontFamily);
      expect(rowFont).toBe(CODE_FONT);
    });
  } finally {
    await harness.cleanup();
  }
});
