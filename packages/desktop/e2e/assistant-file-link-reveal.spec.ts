import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "../../app/e2e/support/fixtures";
import {
  assistantLink,
  expectEditorOpens,
  fileLinkMenu,
  forwardSlashes,
  menuAction,
  openAssistantLinks,
  openLinkMenu,
  revealFromLinkMenu,
} from "./support/assistant-file-links";

test("reveals a link to a file outside the workspace without its line suffix", async ({ page }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-link-reveal-"));
  const file = forwardSlashes(path.join(directory, "sample report.txt"));
  const recordPath = path.join(directory, "opens.jsonl");
  await writeFile(file, "First line\nSecond line\n");
  const agent = await openAssistantLinks(page, { response: `[Report](<${file}:2>)`, recordPath });
  try {
    await openLinkMenu(page, "Report");
    await page.screenshot({ path: test.info().outputPath("file-link-menu.png") });
    await menuAction(page, "Reveal in Explorer").click();
    await expectEditorOpens(recordPath, [
      { editorId: "explorer", workspacePath: agent.cwd, filePath: file },
    ]);
    await expect(fileLinkMenu(page)).toBeHidden();
  } finally {
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("copies the absolute path of a linked file", async ({ page, context }) => {
  const recordPath = test.info().outputPath("opens.jsonl");
  const agent = await openAssistantLinks(page, {
    response: "[Relative](docs/report.txt#L2)",
    files: [{ path: "docs/report.txt", content: "First line\nSecond line\n" }],
    recordPath,
  });
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openLinkMenu(page, "Relative");
    await menuAction(page, "Copy path").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${forwardSlashes(agent.cwd)}/docs/report.txt`);
  } finally {
    await agent.cleanup();
  }
});

test("reveals relative and inline-code links inside the workspace", async ({ page }) => {
  const recordPath = test.info().outputPath("opens.jsonl");
  const agent = await openAssistantLinks(page, {
    response: "[Relative](docs/report.txt#L2)\n\n`report.txt:2`",
    files: [{ path: "docs/report.txt", content: "First line\nSecond line\n" }],
    recordPath,
  });
  try {
    await revealFromLinkMenu(page, "Relative");
    await revealFromLinkMenu(page, "report.txt:2");
    const open = {
      editorId: "explorer",
      workspacePath: agent.cwd,
      filePath: `${forwardSlashes(agent.cwd)}/docs/report.txt`,
    };
    await expectEditorOpens(recordPath, [open, open]);
  } finally {
    await agent.cleanup();
  }
});

test("explains a missing file in the menu and reveals it once it exists", async ({ page }) => {
  const recordPath = test.info().outputPath("opens.jsonl");
  const agent = await openAssistantLinks(page, { response: "`missing.txt:2`", recordPath });
  try {
    await revealFromLinkMenu(page, "missing.txt:2");
    await expect(menuAction(page, /Reveal in Explorer/)).toContainText(
      "No file found for missing.txt:2",
    );
    await writeFile(path.join(agent.cwd, "missing.txt"), "Now available\n");
    await menuAction(page, /Reveal in Explorer/).click();
    await expectEditorOpens(recordPath, [
      {
        editorId: "explorer",
        workspacePath: agent.cwd,
        filePath: `${forwardSlashes(agent.cwd)}/missing.txt`,
      },
    ]);
  } finally {
    await agent.cleanup();
  }
});

test("offers no file menu for a web link", async ({ page }) => {
  const agent = await openAssistantLinks(page, {
    response: "[Web](https://example.com/report.txt)",
    recordPath: test.info().outputPath("opens.jsonl"),
  });
  try {
    await assistantLink(page, "Web").click({ button: "right" });
    await expect(fileLinkMenu(page)).toBeHidden();
  } finally {
    await agent.cleanup();
  }
});

test("does not offer a local file manager for a remote host", async ({ page }) => {
  const agent = await openAssistantLinks(page, { response: "[Remote file](docs/report.txt)" });
  try {
    await assistantLink(page, "Remote file").click({ button: "right" });
    await expect(fileLinkMenu(page)).toBeHidden();
  } finally {
    await agent.cleanup();
  }
});
