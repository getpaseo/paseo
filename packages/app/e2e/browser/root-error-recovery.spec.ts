import { createServer, type Server } from "node:http";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

let server: Server;
let appUrl: string;
test.beforeAll(async () => {
  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) throw new Error("E2E_METRO_PORT is required");
  const bundle = `http://localhost:${metroPort}/packages/app/e2e/support/recovery-app.bundle?platform=web&dev=true&minify=false&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=src%2Fapp`;
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="${bundle}"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not start");
  appUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
});

async function openBrokenStartup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({ state: { layoutByWorkspace: {} }, version: 1 }),
    );
    localStorage.setItem(
      "paseo:last-workspace-route-selection",
      JSON.stringify({ serverId: "fixture-host", workspaceId: "broken" }),
    );
  });
  await page.goto(appUrl);
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toBeVisible();
}
async function readSavedWorkspaceState(page: Page) {
  return page.evaluate(() => ({
    layout: localStorage.getItem("workspace-layout-state"),
    selection: localStorage.getItem("paseo:last-workspace-route-selection"),
  }));
}
async function reloadToPicker(page: Page) {
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page).toHaveURL(`${appUrl}/open-project`);
  await expect(page.getByText("Project picker", { exact: true })).toBeVisible();
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
}
async function openHealthyWorkspace(page: Page) {
  await page.getByRole("link", { name: "Open healthy workspace" }).click();
  await expect(page.getByText("Healthy workspace", { exact: true })).toBeVisible();
}
async function breakCurrentWorkspace(page: Page) {
  await page.getByRole("button", { name: "Break this workspace" }).click();
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toBeVisible();
}
async function captureRecoveryScreen(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("Reload escapes a startup redirect and supports another recovery", async ({
  page,
}, testInfo) => {
  await openBrokenStartup(page);
  const saved = await readSavedWorkspaceState(page);
  await captureRecoveryScreen(page, testInfo, "error-screen");
  await reloadToPicker(page);
  expect(await readSavedWorkspaceState(page)).toEqual(saved);
  await captureRecoveryScreen(page, testInfo, "recovered-picker");
  await openHealthyWorkspace(page);
  await breakCurrentWorkspace(page);
  await reloadToPicker(page);
});

test.describe("compact error recovery", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Reload remains reachable and returns to the picker", async ({ page }, testInfo) => {
    await openBrokenStartup(page);
    await captureRecoveryScreen(page, testInfo, "compact-error-screen");
    await reloadToPicker(page);
    await captureRecoveryScreen(page, testInfo, "compact-recovered-picker");
  });
});
