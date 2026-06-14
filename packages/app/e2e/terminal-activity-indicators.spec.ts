import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "./fixtures";
import { TerminalE2EHarness, type TerminalInstance } from "./helpers/terminal-dsl";

type HookActivityState = "running" | "idle" | "needs-input";
type TabStatusBucket = "running" | "needs_input" | "none";

const TERMINAL_ACTIVITY_REPORTER_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");

const triggerDir = process.argv[1];
const states = ["running", "idle", "needs-input"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTrigger(state) {
  const triggerPath = path.join(triggerDir, state);
  while (!fs.existsSync(triggerPath)) {
    await sleep(50);
  }
}

async function reportActivity(state) {
  const response = await fetch(process.env.PASEO_TERMINAL_ACTIVITY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalId: process.env.PASEO_TERMINAL_ID,
      token: process.env.PASEO_ACTIVITY_TOKEN,
      state,
    }),
  });
  if (!response.ok) {
    throw new Error("Activity report failed: " + response.status);
  }
  process.stdout.write("PASEO_ACTIVITY_REPORTED:" + state + "\\n");
}

(async () => {
  for (const state of states) {
    await waitForTrigger(state);
    await reportActivity(state);
  }
  setInterval(() => {}, 1000);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  setInterval(() => {}, 1000);
});
`;

function internalActivityState(state: HookActivityState): "working" | "idle" | "attention" {
  if (state === "running") return "working";
  if (state === "needs-input") return "attention";
  return "idle";
}

function tabStatusBucket(state: HookActivityState): TabStatusBucket {
  if (state === "running") return "running";
  if (state === "needs-input") return "needs_input";
  return "none";
}

function terminalTab(page: Page, terminalId: string) {
  return page.getByTestId(`workspace-tab-terminal_${terminalId}`).first();
}

async function expectTerminalTabStatus(
  page: Page,
  terminalId: string,
  status: TabStatusBucket,
): Promise<void> {
  await expect(
    terminalTab(page, terminalId).locator(`[data-status-bucket="${status}"]`),
  ).toBeVisible({
    timeout: 15_000,
  });
}

async function focusTerminalTab(page: Page, terminalId: string): Promise<void> {
  await terminalTab(page, terminalId).click();
}

class ControlledActivityTerminal {
  constructor(
    readonly terminal: TerminalInstance,
    private readonly harness: TerminalE2EHarness,
    private readonly triggerDir: string,
  ) {}

  async report(state: HookActivityState): Promise<void> {
    await writeFile(join(this.triggerDir, state), "");
    await this.harness.waitForTerminalActivity({
      terminalId: this.terminal.id,
      state: internalActivityState(state),
      timeoutMs: 15_000,
    });
  }
}

async function createControlledActivityTerminal(
  harness: TerminalE2EHarness,
): Promise<ControlledActivityTerminal> {
  const triggerDir = join(harness.tempRepo.path, ".activity-triggers");
  await mkdir(triggerDir, { recursive: true });
  const terminal = await harness.createTerminal({
    name: "activity-source",
    command: process.execPath,
    args: ["-e", TERMINAL_ACTIVITY_REPORTER_SCRIPT, triggerDir],
  });
  return new ControlledActivityTerminal(terminal, harness, triggerDir);
}

async function withTerminalActivityFixture(
  harness: TerminalE2EHarness,
  fn: (input: {
    activityTerminal: ControlledActivityTerminal;
    focusTerminal: TerminalInstance;
  }) => Promise<void>,
): Promise<void> {
  const activityTerminal = await createControlledActivityTerminal(harness);
  const focusTerminal = await harness.createTerminal({ name: "focus-sink" });
  try {
    await fn({ activityTerminal, focusTerminal });
  } finally {
    await harness.killTerminal(activityTerminal.terminal.id);
    await harness.killTerminal(focusTerminal.id);
  }
}

test.describe("Terminal activity indicators", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-activity-indicators-" });
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("terminal activity follows the tab and clears when the terminal is focused", async ({
    page,
  }) => {
    await withTerminalActivityFixture(harness, async ({ activityTerminal, focusTerminal }) => {
      await harness.openTerminal(page, { terminalId: activityTerminal.terminal.id });
      await harness.openTerminal(page, { terminalId: focusTerminal.id });

      await activityTerminal.report("running");
      await expectTerminalTabStatus(page, activityTerminal.terminal.id, tabStatusBucket("running"));

      await activityTerminal.report("idle");
      await expectTerminalTabStatus(page, activityTerminal.terminal.id, tabStatusBucket("idle"));

      await activityTerminal.report("needs-input");
      await expectTerminalTabStatus(
        page,
        activityTerminal.terminal.id,
        tabStatusBucket("needs-input"),
      );

      await focusTerminalTab(page, activityTerminal.terminal.id);
      await harness.waitForTerminalActivity({
        terminalId: activityTerminal.terminal.id,
        state: "idle",
        timeoutMs: 15_000,
      });
      await expectTerminalTabStatus(page, activityTerminal.terminal.id, "none");
    });
  });
});
