import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const APP_SETTINGS_KEY = "@paseo:app-settings";

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.addInitScript(
    ({ key, language: value }) => {
      localStorage.setItem(key, JSON.stringify({ language: value }));
    },
    { key: APP_SETTINGS_KEY, language },
  );
}

/**
 * Lays the placeholder out the way the textarea does, in a mirror element with
 * the same box and font, and reports whether any of its lines reach the hint.
 */
async function placeholderOverlaps(input: Locator, hint: Locator): Promise<boolean> {
  const hintBox = await hint.boundingBox();
  if (!hintBox) throw new Error("Focus hint has no layout box");
  return input.evaluate((element, box) => {
    const textarea = element as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    const rect = textarea.getBoundingClientRect();
    const mirror = document.createElement("div");
    for (const property of [
      "boxSizing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "textIndent",
      "wordSpacing",
    ] as const) {
      mirror.style[property] = style[property];
    }
    Object.assign(mirror.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      borderStyle: "solid",
      borderColor: "transparent",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      visibility: "hidden",
    });
    const text = document.createTextNode(textarea.placeholder);
    mirror.appendChild(text);
    document.body.appendChild(mirror);
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = Array.from(range.getClientRects());
    mirror.remove();
    return lines.some(
      (line) =>
        line.right > box.x &&
        line.left < box.x + box.width &&
        line.bottom > box.y &&
        line.top < box.y + box.height,
    );
  }, hintBox);
}

const FRENCH_LAYOUTS = [
  { name: "phone width", width: 390, placeholder: "Message, @fichiers, /commandes" },
  {
    name: "desktop width",
    width: 1024,
    placeholder:
      "Écrivez à l’agent, mentionnez des @fichiers ou utilisez les /commandes et /skills",
  },
];

for (const layout of FRENCH_LAYOUTS) {
  test.describe(`French composer at ${layout.name}`, () => {
    test.use({ viewport: { width: layout.width, height: 844 } });

    test("the focus hint does not cover the placeholder", async ({ page }) => {
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "composer-focus-hint-",
        title: "Composer focus hint",
      });

      try {
        await useLanguage(page, "fr");
        await openAgentRoute(page, agent);
        const input = page.getByRole("textbox", { name: "Écrire à l’agent…" }).first();
        await expect(input).toBeVisible();
        await expect(input).toHaveAttribute("placeholder", layout.placeholder);
        await input.evaluate((element) => (element as HTMLTextAreaElement).blur());

        const hint = page.getByText(/pour saisir$/).first();
        await expect(hint).toBeVisible();
        // The input takes the hint's width on the render after the hint lays out.
        await expect.poll(() => placeholderOverlaps(input, hint)).toBe(false);
      } finally {
        await agent.cleanup();
      }
    });
  });
}
