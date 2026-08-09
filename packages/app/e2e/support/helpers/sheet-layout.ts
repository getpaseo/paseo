import { expect, type Locator } from "@playwright/test";

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
