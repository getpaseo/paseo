import { expect, test } from "../support/fixtures";

test("every column of the left sidebar resize handle grabs the handle", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await withWorkspace();
  await workspace.navigateTo();

  const handle = page.getByTestId("left-sidebar-resize-handle");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("Sidebar resize handle is not laid out");

  const missedColumns = await handle.evaluate(
    (element, { left, width, y }) => {
      const missed: number[] = [];
      for (let x = Math.ceil(left); x < left + width; x++) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !element.contains(hit)) missed.push(x);
      }
      return missed;
    },
    { left: box.x, width: box.width, y: box.y + box.height / 2 },
  );

  expect(missedColumns).toEqual([]);
});
