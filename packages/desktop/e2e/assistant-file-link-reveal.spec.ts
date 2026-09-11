import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "../../app/e2e/support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../../app/e2e/support/helpers/mock-agent";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime, type DesktopRuntimeConfig } from "./support/runtime";

const editorTargets: DesktopRuntimeConfig["editorTargets"] = [
  {
    id: "explorer",
    label: "Explorer",
    kind: "file-manager",
    icon: { kind: "symbol", name: "folder" },
  },
];

test("reveals an assistant file link outside the workspace without its line suffix", async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-link-reveal-"));
  const filePath = path.join(directory, "sample report.txt");
  const recordPath = path.join(directory, "opens.jsonl");
  await writeFile(filePath, "First line\nSecond line\n");
  await writeFile(recordPath, "");
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    editorTargets,
    editorRecordPath: recordPath,
  });
  const href = `${filePath.replace(/\\/g, "/")}:2`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-reveal-",
    title: "Reveal file link",
    initialPrompt: "Show the report.",
    featureValues: { mockAssistantResponse: `[Report](<${href}>)` },
  });
  try {
    await openAgentRoute(page, agent);
    const link = page.getByTestId("assistant-message").locator("a").filter({ hasText: "Report" });
    await link.click({ button: "right" });
    const reveal = page.getByTestId("assistant-file-link-reveal");
    await expect(reveal).toHaveText("Reveal in Explorer");
    await expect
      .poll(() =>
        reveal.evaluate((element) => {
          let opacity = 1;
          for (let node: Element | null = element; node; node = node.parentElement) {
            opacity *= Number(getComputedStyle(node).opacity);
          }
          return opacity;
        }),
      )
      .toBe(1);
    await page.screenshot({ path: test.info().outputPath("file-link-menu.png") });
    await reveal.click();
    await expect.poll(async () => (await readFile(recordPath, "utf8")).trim()).not.toBe("");
    const records = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      { editorId: "explorer", workspacePath: agent.cwd, filePath: filePath.replace(/\\/g, "/") },
    ]);
    await expect(page.getByTestId("assistant-file-link-context-menu")).not.toBeVisible();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await link.click({ button: "right" });
    await page.getByTestId("assistant-file-link-copy-path").click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(filePath.replace(/\\/g, "/"));
  } finally {
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves relative and inline-code links, and retries a missing file", async ({ page }) => {
  const recordPath = test.info().outputPath("opens.jsonl");
  await writeFile(recordPath, "");
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    editorTargets,
    editorRecordPath: recordPath,
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-reveal-relative-",
    title: "Reveal relative links",
    repo: { files: [{ path: "docs/report.txt", content: "First line\nSecond line\n" }] },
    initialPrompt: "Show the file links.",
    featureValues: {
      mockAssistantResponse:
        "[Relative](docs/report.txt#L2)\n\n`report.txt:2`\n\n`missing.txt:2`\n\n[Web](https://example.com/report.txt)",
    },
  });
  try {
    await openAgentRoute(page, agent);
    const message = page.getByTestId("assistant-message");
    const reveal = page.getByTestId("assistant-file-link-reveal");
    for (const label of ["Relative", "report.txt:2"]) {
      await message.locator("a").filter({ hasText: label }).click({ button: "right" });
      await reveal.click();
      await expect(page.getByTestId("assistant-file-link-context-menu")).not.toBeVisible();
    }
    const reportPath = `${agent.cwd.replace(/\\/g, "/")}/docs/report.txt`;
    const expectedOpen = { editorId: "explorer", workspacePath: agent.cwd, filePath: reportPath };
    expect(
      (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([expectedOpen, expectedOpen]);

    await message.locator("a").filter({ hasText: "missing.txt:2" }).click({ button: "right" });
    await reveal.click();
    await expect(reveal).toContainText("No file found for missing.txt:2");
    await expect(reveal).toBeEnabled();
    await writeFile(path.join(agent.cwd, "docs", "missing.txt"), "Now available\n");
    await reveal.click();
    await expect(page.getByTestId("assistant-file-link-context-menu")).not.toBeVisible();
    const records = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      expectedOpen,
      expectedOpen,
      { ...expectedOpen, filePath: `${agent.cwd.replace(/\\/g, "/")}/docs/missing.txt` },
    ]);

    await message.locator("a").filter({ hasText: "Web" }).click({ button: "right" });
    await expect(page.getByTestId("assistant-file-link-context-menu")).not.toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

test("does not offer a local file manager for a remote host", async ({ page }) => {
  await installDesktopRuntime(page, { serverId: "another-desktop-host", editorTargets });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-reveal-remote-",
    title: "Remote file link",
    initialPrompt: "Show a file link.",
    featureValues: { mockAssistantResponse: "[Remote file](docs/report.txt)" },
  });
  try {
    await openAgentRoute(page, agent);
    await page.getByTestId("assistant-message").locator("a").click({ button: "right" });
    await expect(page.getByTestId("assistant-file-link-context-menu")).not.toBeVisible();
  } finally {
    await agent.cleanup();
  }
});
