import { test, expect } from './fixtures';
import { gotoHome, openSettings } from './helpers/app';

test('sidebar toggle shows tooltip on the right', async ({ page }) => {
  await gotoHome(page);
  await openSettings(page);

  const menuButton = page.getByRole('button', { name: /menu/i }).first();
  await expect(menuButton).toBeVisible();

  // Baseline: tooltip should appear on keyboard focus (a11y requirement).
  await menuButton.focus();

  const tooltip = page.getByTestId('menu-button-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Toggle sidebar');
  await expect(tooltip).toContainText(/⌘B|Ctrl\+B/);
  await page.waitForTimeout(250);
  await expect(tooltip).toBeVisible();

  // Tooltip should also appear on hover.
  await menuButton.blur();
  await expect(tooltip).toHaveCount(0);
  await menuButton.hover();
  await expect(tooltip).toBeVisible();

  const triggerBox = await menuButton.boundingBox();
  const tooltipBox = await tooltip.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(tooltipBox).not.toBeNull();
  if (!triggerBox || !tooltipBox) return;

  // side=right => tooltip starts to the right of the trigger.
  expect(tooltipBox.x).toBeGreaterThan(triggerBox.x + triggerBox.width - 1);
  // Keep it reasonably close (should be ~trigger.right + offset).
  const expectedX = triggerBox.x + triggerBox.width + 8;
  expect(Math.abs(tooltipBox.x - expectedX)).toBeLessThanOrEqual(12);
  expect(tooltipBox.width).toBeGreaterThanOrEqual(60);
  expect(tooltipBox.width).toBeLessThanOrEqual(500);
  expect(tooltipBox.height).toBeGreaterThanOrEqual(20);
  expect(tooltipBox.height).toBeLessThanOrEqual(80);

  // align=center => centers should be roughly aligned (allow some clamping tolerance).
  const triggerCenterY = triggerBox.y + triggerBox.height / 2;
  const tooltipCenterY = tooltipBox.y + tooltipBox.height / 2;
  expect(Math.abs(triggerCenterY - tooltipCenterY)).toBeLessThanOrEqual(24);
});
