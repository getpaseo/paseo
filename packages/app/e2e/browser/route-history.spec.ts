import { test, configureKeyboardHistory, mouseHistory } from "../support/helpers/route-history";

test.setTimeout(150_000);

test("keyboard history restores tabs, workspaces, Settings and plugin pages", async ({
  page,
  history,
}) => {
  const controls = await configureKeyboardHistory(page);
  await history.visitTabsWorkspacesAndPages();
  await history.retraceVisits(controls);
  await history.skipClosedTabs(controls);
  await history.discardForwardVisitsAndResetOnReload(controls);
});

test("mouse buttons restore application history without configuring shortcuts", async ({
  page,
  history,
}) => {
  const controls = await mouseHistory(page);
  await history.visitTabsWorkspacesAndPages();
  await history.retraceVisits(controls);
  await history.skipClosedTabs(controls);
  await history.discardForwardVisitsAndResetOnReload(controls);
});
