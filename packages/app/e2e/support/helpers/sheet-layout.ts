import { expect, type Locator, type Page } from "@playwright/test";

export interface Rails {
  left: number;
  right: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readBox(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "Expected the element to be laid out").not.toBeNull();
  return box as Box;
}

/** Leading and trailing edges of an element, in whole pixels. */
export async function readRails(locator: Locator): Promise<Rails> {
  const box = await readBox(locator);
  return { left: Math.round(box.x), right: Math.round(box.x + box.width) };
}

/**
 * The two rails an AdaptiveModalSheet header indents to: the title's leading
 * glyph and the close button's trailing edge. Sheet content sits on the same
 * two rails, in every presentation.
 */
export async function readSheetHeaderRails(
  page: Page,
  sheetTestID: string,
  title: string,
): Promise<Rails> {
  const header = page.getByTestId(sheetTestID);
  const [titleRails, closeRails] = await Promise.all([
    readRails(header.getByText(title, { exact: true })),
    readRails(header.getByRole("button", { name: "Close" })),
  ]);
  return { left: titleRails.left, right: closeRails.right };
}

/** Vertical space between the bottom of one element and the top of the next. */
export async function readVerticalGap(upper: Locator, lower: Locator): Promise<number> {
  const [above, below] = await Promise.all([readBox(upper), readBox(lower)]);
  return Math.round(below.y - (above.y + above.height));
}

/**
 * A compact sheet slides up into place, so anything measured across two reads
 * has to wait for the surface to stop moving first.
 */
export async function waitForSettledPosition(locator: Locator): Promise<void> {
  let previousTop: number | null = null;
  await expect
    .poll(
      async () => {
        const { y } = await readBox(locator);
        const settled = previousTop === y;
        previousTop = y;
        return settled;
      },
      { message: "Expected the sheet to stop moving" },
    )
    .toBe(true);
}
