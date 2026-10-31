import { expect, test } from "../support/fixtures";
import {
  composerLocator,
  expectComposerEditable,
  fillComposerDraft,
} from "../support/helpers/composer";
import {
  focusedPixelChange,
  focusRingSideCoverage,
  tabUntilFocused,
} from "../support/helpers/focus-ring";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.describe("keyboard focus ring", () => {
  test.describe.configure({ timeout: 180_000 });

  // The composer toolbar clips with overflow: hidden at the height of its controls, so a ring
  // drawn outside a control lost its top and bottom edges and read as a pair of brackets.
  test("draws all four sides on a composer toolbar control", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "focus-ring-toolbar-",
      title: "Focus ring toolbar e2e",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerEditable(page);
      await composerLocator(page).click();
      const modelSelector = page
        .getByTestId("combined-model-selector")
        .filter({ visible: true })
        .first();
      await tabUntilFocused(page, modelSelector);

      const sides = await focusRingSideCoverage(page, modelSelector);
      expect(
        Math.min(sides.top, sides.right, sides.bottom, sides.left),
        `ring coverage per side: ${JSON.stringify(sides)}`,
      ).toBeGreaterThanOrEqual(0.9);
    } finally {
      await session.cleanup();
    }
  });

  // The ring is drawn inside the control, on its fill. On the accent-filled Send button it
  // has the fill's own colour, so it needs the surface band to show at all.
  test("visibly marks the accent-filled Send button", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "focus-ring-send-",
      title: "Focus ring send e2e",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerEditable(page);
      await fillComposerDraft(page, "hello");
      const send = page.getByRole("button", { name: "Send message", exact: true });
      await expect(send).toBeVisible();

      const { changed, perimeter } = await focusedPixelChange(page, send, () =>
        tabUntilFocused(page, send),
      );
      // A ring around the control changes at least one perimeter's worth of pixels.
      expect(changed, `changed pixels around a ${perimeter}px perimeter`).toBeGreaterThanOrEqual(
        perimeter,
      );
    } finally {
      await session.cleanup();
    }
  });
});
