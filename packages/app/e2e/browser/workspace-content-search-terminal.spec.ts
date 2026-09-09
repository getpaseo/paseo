import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

test("content-search entry and dismissal preserve live shell input and terminal focus", async ({
  page,
}, testInfo) => {
  const harness = await TerminalE2EHarness.create({ tempPrefix: "content-search-terminal-" });
  try {
    const terminal = await harness.createTerminal({ name: "Search shortcut QA" });
    await writeFile(
      path.join(harness.tempRepo.path, "source.ts"),
      'export const greeting = "needle";\n',
    );
    await harness.openTerminal(page, { terminalId: terminal.id });
    await harness.setupPrompt(page);
    await searchFromPendingShellCommand(page, harness, testInfo.outputPath("terminal-search.png"));
    expect(await readFile(path.join(harness.tempRepo.path, "shell-input.txt"), "utf8")).toBe(
      "untouched",
    );
  } finally {
    await harness.cleanup();
  }
});

async function searchFromPendingShellCommand(
  page: import("@playwright/test").Page,
  harness: TerminalE2EHarness,
  screenshot: string,
) {
  const terminal = harness.terminalSurface(page);
  await terminal.pressSequentially("printf untouched > shell-input.txt", { delay: 0 });
  await page.keyboard.press("Control+Shift+F");
  const query = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });
  await expect(query).toBeFocused();
  await query.pressSequentially("needle", { delay: 0 });
  await expect(page.getByRole("button", { name: /source.ts:1:26/ })).toBeVisible();
  await page.screenshot({ path: screenshot });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-center-panel")).toBeHidden();
  await page.keyboard.press("Enter");
  await terminal.pressSequentially("printf '\\nSEARCH_SHELL_RESUMED\\n'\n", { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes("SEARCH_SHELL_RESUMED"), 10_000);
}
