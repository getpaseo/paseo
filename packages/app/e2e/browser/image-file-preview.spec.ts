import { test, expect } from "../support/fixtures";
import {
  expectFileTabOpen,
  expandFolder,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const DIAGRAM_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAB5ElEQVR4nO2UQQ3AQACDzgK/OZh/hTcZawIPDBTSw/PeaAN+2uAUX/Hx4wYFWIC3AIvgWjfoAQckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQgpgAHJCCmAAckIKYAByQg5gMbEaAIyms80wAAAABJRU5ErkJggg==",
  "base64",
);

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "image-file-preview-",
    repo: {
      files: [
        { path: "assets/diagram.png", content: DIAGRAM_PNG },
        { path: "assets/alternate.png", content: DIAGRAM_PNG },
      ],
    },
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test("fits, zooms around the pointer, pans, and resets a workspace image", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);
  await expandFolder(page, "assets");
  await openFileFromExplorer(page, "diagram.png");
  await expectFileTabOpen(page, "assets/diagram.png");

  const preview = page.getByTestId("image-file-preview").filter({ visible: true });
  const canvas = preview.getByTestId("image-file-preview-canvas");
  const image = canvas.locator("img");
  await expect(preview).toBeVisible();
  await expect(image).toBeVisible();

  const fittedBox = await image.boundingBox();
  const canvasBox = await canvas.boundingBox();
  const paneBox = await page
    .getByTestId("workspace-file-pane")
    .filter({ visible: true })
    .boundingBox();
  expect(fittedBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height + 1);
  expect(fittedBox!.width).toBeLessThanOrEqual(canvasBox!.width + 1);
  expect(fittedBox!.height).toBeLessThanOrEqual(canvasBox!.height + 1);

  await preview.getByTestId("image-file-preview-zoom-in").click();
  await expect
    .poll(async () => (await image.boundingBox())?.width ?? 0)
    .toBeGreaterThan(fittedBox!.width * 1.2);

  await preview.getByTestId("image-file-preview-zoom-out").click();
  await expect
    .poll(async () => Math.round((await image.boundingBox())?.width ?? 0))
    .toBe(Math.round(fittedBox!.width));
  await preview.getByTestId("image-file-preview-zoom-in").click();
  await expect
    .poll(async () => (await image.boundingBox())?.width ?? 0)
    .toBeGreaterThan(fittedBox!.width * 1.2);
  for (let step = 0; step < 3; step += 1) {
    await preview.getByTestId("image-file-preview-zoom-in").click();
  }

  const beforeWheel = await image.boundingBox();
  await page.mouse.move(
    canvasBox!.x + canvasBox!.width * 0.75,
    canvasBox!.y + canvasBox!.height / 2,
  );
  await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => (await image.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeWheel!.width);
  const afterWheel = await image.boundingBox();
  expect(afterWheel!.x).toBeLessThan(beforeWheel!.x);

  const beforePan = await image.boundingBox();
  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    canvasBox!.x + canvasBox!.width / 2 + 80,
    canvasBox!.y + canvasBox!.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await image.boundingBox())?.x ?? 0)
    .toBeGreaterThan(beforePan!.x + 60);

  await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + canvasBox!.width * 3, canvasBox!.y + canvasBox!.height / 2);
  await page.mouse.up();
  const clampedBox = await image.boundingBox();
  expect(clampedBox).not.toBeNull();
  expect(Math.abs(clampedBox!.x - canvasBox!.x)).toBeLessThanOrEqual(2);

  await preview.getByTestId("image-file-preview-reset").click();
  await expect
    .poll(async () => Math.round((await image.boundingBox())?.width ?? 0))
    .toBe(Math.round(fittedBox!.width));
  const resetBox = await image.boundingBox();
  expect(Math.abs(resetBox!.x + resetBox!.width / 2 - (canvasBox!.x + canvasBox!.width / 2))).toBe(
    0,
  );

  await preview.getByTestId("image-file-preview-zoom-in").click();
  await expect(preview.getByTestId("image-file-preview-zoom-out")).toBeEnabled();
  await openFileFromExplorer(page, "alternate.png");
  await expectFileTabOpen(page, "assets/alternate.png");
  await expect(preview.getByTestId("image-file-preview-zoom-out")).toBeDisabled();

  await preview.getByTestId("image-file-preview-zoom-in").click();
  await expect(preview.getByTestId("image-file-preview-zoom-out")).toBeEnabled();
  const initialViewport = page.viewportSize();
  expect(initialViewport).not.toBeNull();
  await page.setViewportSize({
    width: initialViewport!.width - 160,
    height: initialViewport!.height - 80,
  });
  await expect(preview.getByTestId("image-file-preview-zoom-out")).toBeDisabled();
  const resizedCanvasBox = await canvas.boundingBox();
  const resizedImageBox = await image.boundingBox();
  expect(resizedCanvasBox).not.toBeNull();
  expect(resizedImageBox).not.toBeNull();
  expect(
    Math.abs(
      resizedImageBox!.x +
        resizedImageBox!.width / 2 -
        (resizedCanvasBox!.x + resizedCanvasBox!.width / 2),
    ),
  ).toBeLessThanOrEqual(1);
});
