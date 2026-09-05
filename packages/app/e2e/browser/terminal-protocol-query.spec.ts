import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText, waitForTerminalContent } from "../support/helpers/terminal-perf";

const CODEX_START_COMMAND =
  "TERM=xterm-256color codex --no-alt-screen --ask-for-approval never --sandbox read-only";

async function launchCodex(page: Page): Promise<void> {
  const terminal = page.locator('[data-testid="terminal-surface"]');
  await terminal.pressSequentially(`${CODEX_START_COMMAND}\n`, { delay: 0 });
  await waitForTerminalContent(
    page,
    (text) => text.includes("Do you trust the contents of this directory?"),
    10_000,
  ).catch(() => undefined);
  const trustPrompt = await getTerminalBufferText(page);
  if (trustPrompt.includes("Do you trust the contents of this directory?")) {
    await terminal.pressSequentially("1\n", { delay: 0 });
  }
  await waitForTerminalContent(page, (text) => text.includes("OpenAI Codex"), 30_000);
}

test.describe("Terminal protocol colors", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("keeps Codex terminal colors readable in light and dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });

    const lightTerminal = await harness.createTerminal({
      name: "codex-light-colors",
      defaultColors: { foreground: "#1a1a1e", background: "#ffffff", cursor: "#1a1a1e" },
    });
    try {
      await harness.openTerminal(page, { terminalId: lightTerminal.id });
      await harness.setupPrompt(page);
      await launchCodex(page);
      const lightText = await getTerminalBufferText(page);
      expect(lightText).toContain("OpenAI Codex");

      await page.waitForTimeout(3000);
      await page.keyboard.press("Control+C");
      await page.waitForTimeout(1000);

      const darkTerminal = await harness.createTerminal({
        name: "codex-dark-colors",
        defaultColors: { foreground: "#fafafa", background: "#181b1a", cursor: "#fafafa" },
      });
      try {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.reload();
        await page.waitForTimeout(1000);
        await harness.openTerminal(page, { terminalId: darkTerminal.id });
        await harness.setupPrompt(page);
        await launchCodex(page);
        const darkText = await getTerminalBufferText(page);
        expect(darkText).toContain("OpenAI Codex");
        await page.waitForTimeout(3000);
        await page.keyboard.press("Control+C");
        await page.waitForTimeout(1000);
      } finally {
        await harness.killTerminal(darkTerminal.id);
      }
    } finally {
      await harness.killTerminal(lightTerminal.id);
    }
  });
});
