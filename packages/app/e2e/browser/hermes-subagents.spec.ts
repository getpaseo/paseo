import { verifyHermesFixturePanels, verifyHermesLimits } from "../support/helpers/hermes-subagents";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "../support/fixtures";

// Default: self-contained ACP contract fixture. Optional: run the companion
// Hermes PR's executable fixture through the real Python ACP server and relay.
const python = process.env.PASEO_HERMES_ACP_FIXTURE_PYTHON;
const script = process.env.PASEO_HERMES_ACP_FIXTURE_SCRIPT;
if (Boolean(python) !== Boolean(script)) throw new Error("Set both Hermes fixture overrides");
const fixtureHome = mkdtempSync(path.join(tmpdir(), "paseo-hermes-no-model-"));
const command =
  python && script
    ? [python, script]
    : [process.execPath, path.resolve("e2e/fixtures/hermes-subagents.cjs")];
test.use({
  e2eDaemonEnvironment: { HERMES_HOME: fixtureHome },
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        hermes: { extends: "acp", label: "Hermes fixture", enabled: true, command },
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});
test.afterAll(() => rmSync(fixtureHome, { recursive: true, force: true }));

for (const scenario of [
  { name: "desktop-light", theme: "light", width: 1400, height: 950 },
  { name: "desktop-dark", theme: "dark", width: 1400, height: 950 },
  { name: "compact-light", theme: "light", width: 390, height: 844 },
] as const) {
  test(`NO-MODEL FIXTURE reuses Hermes child panels ${scenario.name}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(
      (theme) => localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme })),
      scenario.theme,
    );
    await verifyHermesFixturePanels(page, testInfo, scenario);
  });
}

test("NO-MODEL FIXTURE visibly marks incomplete records", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await verifyHermesLimits(page, testInfo);
});
