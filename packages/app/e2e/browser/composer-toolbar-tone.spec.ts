import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import {
  composerControl,
  expectGlyphMatchesLabel,
  expectIconOnlyGlyph,
  readComposerControlTone,
  readComposerPlaceholderTone,
  readComposerTextTone,
} from "../support/helpers/composer-toolbar-tone";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const THINKING = "agent-thinking-selector";
const MODE = "mode-control";
const ATTACH = "message-input-attach-button";
const COMBINED_MODEL = "combined-model-selector";

async function openSeededComposer(
  page: import("@playwright/test").Page,
  repoPrefix: string,
  readyTestId = MODE,
) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Toolbar tone",
    model: "ten-second-stream",
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await expect(composerControl(page, readyTestId)).toBeVisible({ timeout: 30_000 });
    return agent;
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

test.describe("Composer toolbar glyph tone", () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true, viewport: { width: 1024, height: 1366 } });

    test("a glyph beside its label matches the label while an icon-only glyph stays foreground", async ({
      page,
    }) => {
      const agent = await openSeededComposer(page, "composer-tone-touch-");
      try {
        const thinking = await readComposerControlTone(composerControl(page, THINKING));
        const mode = await readComposerControlTone(composerControl(page, MODE));
        const attach = await readComposerControlTone(composerControl(page, ATTACH));

        expectGlyphMatchesLabel(thinking, "thinking");
        expectGlyphMatchesLabel(mode, "mode");
        expectIconOnlyGlyph(attach, "attach");
        expect(attach.glyph, "an icon-only glyph is brighter than a labelled glyph").not.toBe(
          thinking.label,
        );
      } finally {
        await agent.cleanup();
      }
    });
  });

  test.describe("on a compact non-touch window", () => {
    test.use({ hasTouch: false, viewport: { width: 590, height: 844 } });

    test("the icon-only thinking glyph stays foreground and the labelled mode glyph matches its label", async ({
      page,
    }) => {
      const agent = await openSeededComposer(page, "composer-tone-compact-");
      try {
        const thinking = await readComposerControlTone(composerControl(page, THINKING));
        const mode = await readComposerControlTone(composerControl(page, MODE));
        const attach = await readComposerControlTone(composerControl(page, ATTACH));

        expectIconOnlyGlyph(thinking, "thinking");
        expectGlyphMatchesLabel(mode, "mode");
        expectIconOnlyGlyph(attach, "attach");
        expect(thinking.glyph, "the icon-only glyphs share one tone").toBe(attach.glyph);
        expect(thinking.glyph, "an icon-only glyph is brighter than a labelled glyph").not.toBe(
          mode.label,
        );
      } finally {
        await agent.cleanup();
      }
    });
  });

  test.describe("on a folded compact non-touch window", () => {
    test.use({ hasTouch: false, viewport: { width: 480, height: 844 } });

    test("the empty composer placeholder is quieter than its labels", async ({ page }) => {
      const agent = await openSeededComposer(page, "composer-tone-placeholder-", COMBINED_MODEL);
      try {
        const placeholder = await readComposerPlaceholderTone(composerLocator(page));
        const extraMuted = await readComposerTextTone(
          composerControl(page, "combined-model-selector-thinking-label"),
        );
        const muted = await readComposerTextTone(
          composerControl(page, "combined-model-selector-model-label"),
        );

        expect(placeholder, "the composer paints a placeholder").not.toBeNull();
        expect(extraMuted, "the folded thinking label paints the extra-muted tone").not.toBeNull();
        expect(placeholder, "the placeholder uses the extra-muted tone").toBe(extraMuted);
        expect(placeholder, "the placeholder is quieter than a labelled glyph").not.toBe(muted);
      } finally {
        await agent.cleanup();
      }
    });
  });

  test.describe("with a wide pointer", () => {
    test.use({ hasTouch: false, viewport: { width: 1280, height: 800 } });

    test("a labelled glyph stays muted and matches its label", async ({ page }) => {
      const agent = await openSeededComposer(page, "composer-tone-pointer-");
      try {
        const thinking = await readComposerControlTone(composerControl(page, THINKING));
        const mode = await readComposerControlTone(composerControl(page, MODE));

        expectGlyphMatchesLabel(thinking, "thinking");
        expectGlyphMatchesLabel(mode, "mode");
      } finally {
        await agent.cleanup();
      }
    });
  });
});
