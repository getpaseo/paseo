import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { delayFileReadResponse } from "../support/helpers/file-read-gate";
import {
  expandFolder,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "file-transition-",
    repo: {
      files: [
        { path: "src/a.ts", content: "export const sourceA = true;\n" },
        { path: "src/b.ts", content: "export const sourceB = true;\n" },
        { path: "docs/b.md", content: "# Markdown B\n" },
      ],
    },
  });
});

test.afterAll(async () => workspace?.cleanup());

async function openSourceA(page: import("@playwright/test").Page) {
  await openFileExplorer(page);
  await expandFolder(page, "src");
  await openFileFromExplorer(page, "a.ts");
  await expect(page.getByText("export const sourceA = true;")).toBeVisible({ timeout: 30_000 });
}

async function assertHeldFileTransition(
  page: import("@playwright/test").Page,
  targetPath: string,
  finalText: string,
  gate: Awaited<ReturnType<typeof delayFileReadResponse>>,
) {
  await page.evaluate((tabTestId) => {
    const timeline: Array<{ chip: boolean; loading: boolean; unavailable: boolean }> = [];
    const sample = () => {
      const next = {
        chip: Boolean(document.querySelector(`[data-testid="${tabTestId}"]`)),
        loading: Boolean(document.querySelector('[data-testid="file-preview-loading"]')),
        unavailable: Boolean(document.querySelector('[data-testid="file-preview-unsupported"]')),
      };
      if (JSON.stringify(timeline.at(-1)) !== JSON.stringify(next)) timeline.push(next);
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    (
      window as typeof window & { __fileTransitionTimeline?: typeof timeline }
    ).__fileTransitionTimeline = timeline;
    (
      window as typeof window & { __fileTransitionObserver?: MutationObserver }
    ).__fileTransitionObserver = observer;
  }, `workspace-tab-file_${targetPath}`);
  await openFileFromExplorer(page, targetPath.split("/").pop() as string);
  await gate.waitUntilHeld();

  const targetChip = page.getByTestId(`workspace-tab-file_${targetPath}`).first();
  await expect(targetChip).toBeVisible();
  await expect(targetChip).toContainText(targetPath.split("/").pop() as string);
  await expect(page.getByTestId("file-preview-loading")).toBeVisible();
  await expect(page.getByTestId("file-preview-unsupported")).toHaveCount(0);
  await expect(page.getByText("export const sourceA = true;")).toHaveCount(0);

  const heldTimeline = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __fileTransitionTimeline?: Array<{
            chip: boolean;
            loading: boolean;
            unavailable: boolean;
          }>;
        }
      ).__fileTransitionTimeline ?? [],
  );
  expect(heldTimeline).toContainEqual(expect.objectContaining({ chip: true, loading: true }));
  expect(heldTimeline).not.toContainEqual(expect.objectContaining({ unavailable: true }));
  const descriptorIndex = heldTimeline.findIndex((sample) => sample.chip);
  expect(heldTimeline.slice(descriptorIndex)).not.toContainEqual(
    expect.objectContaining({ chip: false }),
  );

  gate.release();
  await expect(page.getByText(finalText)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("file-preview-loading")).toHaveCount(0);
  const timeline = await page.evaluate(() => {
    const windowWithTimeline = window as typeof window & {
      __fileTransitionTimeline?: Array<{ chip: boolean; loading: boolean; unavailable: boolean }>;
      __fileTransitionObserver?: MutationObserver;
    };
    windowWithTimeline.__fileTransitionObserver?.disconnect();
    return windowWithTimeline.__fileTransitionTimeline ?? [];
  });
  expect(
    timeline.filter((sample, index) => sample.loading && !timeline[index - 1]?.loading),
  ).toHaveLength(1);
}

test.describe("File target transitions", () => {
  test("keeps the Markdown descriptor and loading state stable through a real delayed read", async ({
    page,
  }) => {
    const gate = await delayFileReadResponse(page, "docs/b.md");
    await page.reload();
    await gotoWorkspace(page, workspace.workspaceId);
    await openSourceA(page);
    await expandFolder(page, "docs");
    await assertHeldFileTransition(page, "docs/b.md", "Markdown B", gate);
  });

  test("keeps the source descriptor and loading state stable through a real delayed read", async ({
    page,
  }) => {
    const gate = await delayFileReadResponse(page, "src/b.ts");
    await page.reload();
    await gotoWorkspace(page, workspace.workspaceId);
    await openSourceA(page);
    await assertHeldFileTransition(page, "src/b.ts", "export const sourceB = true;", gate);
  });
});
