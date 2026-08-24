import { expect, type Locator } from "@playwright/test";

interface TruncatedLabel {
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

export async function expectNoTruncation(locator: Locator): Promise<void> {
  await expect(locator.first()).toBeVisible({ timeout: 30_000 });

  const truncated = await locator.evaluateAll((elements): TruncatedLabel[] => {
    function isVisible(element: HTMLElement): boolean {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function directText(element: HTMLElement): string {
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
    }

    const checked = new Set<HTMLElement>();
    const failures: TruncatedLabel[] = [];

    for (const root of elements) {
      if (!(root instanceof HTMLElement) || !isVisible(root)) continue;
      const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];

      for (const candidate of candidates) {
        if (checked.has(candidate) || !isVisible(candidate) || candidate.clientWidth <= 0) {
          continue;
        }
        checked.add(candidate);

        const text = directText(candidate);
        if (!text) continue;
        if (candidate.scrollWidth <= candidate.clientWidth) continue;

        failures.push({
          text,
          scrollWidth: candidate.scrollWidth,
          clientWidth: candidate.clientWidth,
        });
      }
    }

    return failures;
  });

  expect(truncated, "option labels should not be horizontally truncated").toEqual([]);
}
