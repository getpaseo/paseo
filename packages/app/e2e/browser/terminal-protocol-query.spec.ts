import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
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

const LIGHT_TERMINAL_COLORS = {
  10: "rgb:1a1a/1a1a/1e1e",
  11: "rgb:ffff/ffff/ffff",
  12: "rgb:1a1a/1a1a/1e1e",
} as const;

const DARK_TERMINAL_COLORS = {
  10: "rgb:fafa/fafa/fafa",
  11: "rgb:1818/1b1b/1a1a",
  12: "rgb:fafa/fafa/fafa",
} as const;

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

test.describe("Terminal protocol colors", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("reports the active app palette through OSC color queries", async ({ page }) => {
    const probePath = join(harness.tempRepo.path, "osc-color-probe.cjs");
    writeFileSync(probePath, OSC_COLOR_PROBE_SCRIPT, "utf8");

    await page.addInitScript(() => {
      if (!localStorage.getItem("@paseo:app-settings")) {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "light" }));
      }
    });
    await gotoWorkspace(page, harness.workspaceId);
    const lightTerminals = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
      workspaceId: harness.workspaceId,
    });
    const lightTerminalIds = new Set(lightTerminals.terminals.map((terminal) => terminal.id));
    await clickNewTerminal(page);
    await expectTerminalSurfaceVisible(page);
    await setupDeterministicPrompt(page);
    const lightTerminalId = await waitForCreatedTerminal(harness, lightTerminalIds);
    try {
      for (const code of [10, 11, 12] as const) {
        await queryOscColor(page, probePath, code, LIGHT_TERMINAL_COLORS[code]);
      }
    } finally {
      await harness.killTerminal(lightTerminalId);
    }

    await page.evaluate(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "dark" }));
    });
    await page.reload();
    await gotoWorkspace(page, harness.workspaceId);
    const darkTerminals = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
      workspaceId: harness.workspaceId,
    });
    const darkTerminalIds = new Set(darkTerminals.terminals.map((terminal) => terminal.id));
    await clickNewTerminal(page);
    await expectTerminalSurfaceVisible(page);
    await setupDeterministicPrompt(page);
    const darkTerminalId = await waitForCreatedTerminal(harness, darkTerminalIds);
    try {
      for (const code of [10, 11, 12] as const) {
        await queryOscColor(page, probePath, code, DARK_TERMINAL_COLORS[code]);
      }
    } finally {
      await harness.killTerminal(darkTerminalId);
    }
  });
});
