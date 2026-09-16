import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { openSettingsSection } from "../support/helpers/settings";
import {
  expectTerminalSurfaceVisible,
  setupDeterministicPrompt,
  waitForTerminalContent,
} from "../support/helpers/terminal-perf";

const OSC_COLOR_PROBE_SCRIPT = `process.stdin.setRawMode(true);
process.stdin.resume();
const code = process.argv[2];
let buf = "";
const timer = setTimeout(() => {
  process.stdout.write("OSC_COLOR_TIMEOUT\\n");
  process.exit(2);
}, 2500);
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("binary");
  const match = buf.match(new RegExp("\\\\x1b\\\\]" + code + ";rgb:[0-9a-f/]+\\\\x1b\\\\\\\\"));
  if (!match) {
    return;
  }
  clearTimeout(timer);
  process.stdout.write("OSC_COLOR_OK:" + code + ":" + match[0].replace(/\\x1b/g, "ESC") + "\\n");
  process.exit(0);
});
process.stdout.write("\\x1b]" + code + ";?\\x07");
`;

const TERMINAL_PALETTE_SCENARIOS = {
  light: {
    label: "Light",
    foreground: "rgb(26, 26, 30)",
    colors: {
      10: "rgb:1a1a/1a1a/1e1e",
      11: "rgb:ffff/ffff/ffff",
      12: "rgb:1a1a/1a1a/1e1e",
    },
  },
  dark: {
    label: "Dark",
    foreground: "rgb(250, 250, 250)",
    colors: {
      10: "rgb:fafa/fafa/fafa",
      11: "rgb:1818/1b1b/1a1a",
      12: "rgb:fafa/fafa/fafa",
    },
  },
} as const;

type TerminalPaletteScenario =
  (typeof TERMINAL_PALETTE_SCENARIOS)[keyof typeof TERMINAL_PALETTE_SCENARIOS];

async function waitForCreatedTerminal(
  harness: TerminalE2EHarness,
  knownTerminalIds: Set<string>,
): Promise<string> {
  let createdTerminalId: string | undefined;
  await expect
    .poll(
      async () => {
        const result = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
          workspaceId: harness.workspaceId,
        });
        createdTerminalId = result.terminals.find(
          (terminal) => !knownTerminalIds.has(terminal.id),
        )?.id;
        return createdTerminalId;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  return createdTerminalId!;
}

async function queryOscColor(
  page: Page,
  probePath: string,
  code: 10 | 11 | 12,
  expected: string,
): Promise<void> {
  const terminal = page.locator('[data-testid="terminal-surface"]');
  const expectedOutput = `OSC_COLOR_OK:${code}:ESC]${code};${expected}ESC\\`;
  await terminal.pressSequentially(`${process.execPath} "${probePath}" ${code}\n`, { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes(expectedOutput), 10_000);
}

function createOscColorProbe(repoPath: string): string {
  const probePath = join(repoPath, "osc-color-probe.cjs");
  writeFileSync(probePath, OSC_COLOR_PROBE_SCRIPT, "utf8");
  return probePath;
}

async function selectAppTheme(page: Page, scenario: TerminalPaletteScenario): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeTrigger = page.getByLabel(/^Theme: /).first();
  await themeTrigger.click();
  await page.getByRole("menuitem", { name: scenario.label, exact: true }).click();
  await expect(themeTrigger).toHaveAccessibleName(`Theme: ${scenario.label}`);
  await expect(themeTrigger.getByText(scenario.label, { exact: true })).toHaveCSS(
    "color",
    scenario.foreground,
  );
}

async function assertTerminalPalette(
  page: Page,
  probePath: string,
  colors: TerminalPaletteScenario["colors"],
): Promise<void> {
  for (const code of [10, 11, 12] as const) {
    await queryOscColor(page, probePath, code, colors[code]);
  }
}

async function exerciseTerminalPalette(
  page: Page,
  harness: TerminalE2EHarness,
  probePath: string,
  scenario: TerminalPaletteScenario,
): Promise<void> {
  await selectAppTheme(page, scenario);
  await gotoWorkspace(page, harness.workspaceId);

  const existingTerminals = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
    workspaceId: harness.workspaceId,
  });
  const knownTerminalIds = new Set(existingTerminals.terminals.map((terminal) => terminal.id));
  await clickNewTerminal(page);
  await expectTerminalSurfaceVisible(page);
  await setupDeterministicPrompt(page);
  const terminalId = await waitForCreatedTerminal(harness, knownTerminalIds);
  try {
    await assertTerminalPalette(page, probePath, scenario.colors);
  } finally {
    await harness.killTerminal(terminalId);
  }
}

test.describe("Terminal protocol colors", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("reports the active app palette through OSC color queries", async ({ page }) => {
    const probePath = createOscColorProbe(harness.tempRepo.path);
    await exerciseTerminalPalette(page, harness, probePath, TERMINAL_PALETTE_SCENARIOS.light);
    await exerciseTerminalPalette(page, harness, probePath, TERMINAL_PALETTE_SCENARIOS.dark);
  });
});
