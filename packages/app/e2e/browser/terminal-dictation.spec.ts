import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import {
  holdMicrophone,
  installDictationWsHarness,
  installSyntheticMicrophone,
  microphoneStats,
  releaseMicrophone,
  type DictationCapability,
  type DictationWsHarness,
} from "../support/helpers/dictation-ws";
import { TerminalE2EHarness, type TerminalInstance } from "../support/helpers/terminal-dsl";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const LINUX_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Payloads are echoed as JSON with whitespace escaped, because the PTY capture
// below drops whitespace when it joins wrapped lines.
const ENCODE = String.raw`
const encode = (text) =>
  JSON.stringify(text).replace(
    /\s/g,
    (space) => "\\u" + space.charCodeAt(0).toString(16).padStart(4, "0"),
  );
`;

// A TUI with bracketed paste on: echoes each paste body as INPUT:<json>.
const BRACKETED_RECEIVER_SCRIPT = String.raw`
${ENCODE}
let buffer = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004hDICTATION_RECEIVER_READY\r\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const paste = /\x1b\[200~([^]*?)\x1b\[201~/.exec(buffer);
    if (!paste) break;
    process.stdout.write("INPUT:" + encode(paste[1]) + "\r\n");
    buffer = buffer.slice(0, paste.index) + buffer.slice(paste.index + paste[0].length);
  }
});
`;

// A program without bracketed paste: echoes every stdin byte, in raw mode so
// Ctrl+D arrives as \x04, as RAW_INPUT:<json> after a quiet period.
const RAW_RECEIVER_SCRIPT = String.raw`
${ENCODE}
let pending = "";
let timer = null;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("RAW_RECEIVER_READY\r\n");
process.stdin.on("data", (chunk) => {
  pending += chunk.toString();
  clearTimeout(timer);
  timer = setTimeout(() => {
    process.stdout.write("RAW_INPUT:" + encode(pending) + "\r\n");
    pending = "";
  }, 200);
});
`;

type ReceiverKind = "bracketed" | "raw";

function visibleTestId(scope: Page | Locator, testId: string): Locator {
  return scope.getByTestId(testId).filter({ visible: true }).first();
}

// Click the surface, not its helper textarea: the textarea sits at the left edge,
// under a split or Explorer resize handle.
function terminalSurface(scope: Page | Locator): Locator {
  return scope.getByTestId("terminal-surface").filter({ visible: true });
}

function terminalInput(scope: Page | Locator): Locator {
  return scope
    .getByTestId("terminal-surface")
    .filter({ visible: true })
    .locator(".xterm-helper-textarea");
}

function splitChild(page: Page, terminal: TerminalInstance): Locator {
  return page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId(`workspace-tab-terminal_${terminal.id}`) });
}

function explorerSidebar(page: Page): Locator {
  return page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }).first();
}

async function dragTabIntoExplorer(page: Page, terminal: TerminalInstance): Promise<void> {
  const source = page
    .getByTestId("workspace-pane-main")
    .getByTestId(`workspace-tab-terminal_${terminal.id}`);
  const destination = explorerSidebar(page).getByTestId("workspace-tab-files");
  const sourceBox = await source.boundingBox();
  const destinationBox = await destination.boundingBox();
  if (!sourceBox || !destinationBox) {
    throw new Error("Tab drag requires visible source and destination");
  }
  const start = { x: sourceBox.x + 12, y: sourceBox.y + sourceBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 4);
  await page.mouse.move(destinationBox.x + 12, destinationBox.y + destinationBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
}

async function expectMicrophoneStat(
  page: Page,
  stat: "trackStops" | "getUserMediaCalls",
  count: number,
): Promise<void> {
  await expect.poll(async () => (await microphoneStats(page))[stat]).toBe(count);
}

test.describe("Terminal dictation", () => {
  test.describe.configure({ timeout: 180_000 });

  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-dictation-" });
    await writeFile(
      path.join(harness.tempRepo.path, "bracketed-receiver.cjs"),
      BRACKETED_RECEIVER_SCRIPT,
    );
    await writeFile(path.join(harness.tempRepo.path, "raw-receiver.cjs"), RAW_RECEIVER_SCRIPT);
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  const terminals: TerminalInstance[] = [];

  test.afterEach(async () => {
    for (const terminal of terminals.splice(0)) {
      await harness.killTerminal(terminal.id);
    }
  });

  async function createReceiver(kind: ReceiverKind, name: string): Promise<TerminalInstance> {
    const terminal = await harness.createTerminal({
      name,
      command: process.execPath,
      args: [kind === "bracketed" ? "bracketed-receiver.cjs" : "raw-receiver.cjs"],
    });
    terminals.push(terminal);
    await expectTerminalOutput(
      terminal.id,
      kind === "bracketed" ? "DICTATION_RECEIVER_READY" : "RAW_RECEIVER_READY",
    );
    return terminal;
  }

  async function setup(
    page: Page,
    options: { transcript?: string; capability?: DictationCapability } = {},
  ): Promise<DictationWsHarness> {
    await installSyntheticMicrophone(page);
    return await installDictationWsHarness(page, {
      transcript: options.transcript ?? "first\nsecond",
      capability: options.capability,
    });
  }

  // Reads the PTY itself, so output from one pane cannot satisfy another's check.
  async function terminalOutput(terminalId: string): Promise<string> {
    const capture = await harness.client.captureTerminal(terminalId);
    return capture.lines.join("").replace(/\s/g, "");
  }

  async function expectTerminalOutput(terminalId: string, text: string): Promise<void> {
    await expect.poll(() => terminalOutput(terminalId), { timeout: 10_000 }).toContain(text);
  }

  /** Everything the receiver got, in order and joined. */
  async function received(terminalId: string, kind: ReceiverKind): Promise<string> {
    const label = kind === "bracketed" ? "INPUT" : "RAW_INPUT";
    const output = await terminalOutput(terminalId);
    return [
      ...output.matchAll(
        new RegExp(
          `${kind === "bracketed" ? "(?<!RAW_)" : ""}${label}:("(?:[^"\\\\]|\\\\.)*")`,
          "g",
        ),
      ),
    ]
      .map(([, json]) => JSON.parse(json) as string)
      .join("");
  }

  async function expectReceived(
    terminalId: string,
    kind: ReceiverKind,
    text: string,
  ): Promise<void> {
    await expect.poll(() => received(terminalId, kind), { timeout: 15_000 }).toBe(text);
  }

  /** Gives a late transcript time to land, then checks that none did. */
  async function expectNothingReceived(
    page: Page,
    ...receivers: Array<[TerminalInstance, ReceiverKind]>
  ): Promise<void> {
    await page.waitForTimeout(1_500);
    for (const [terminal, kind] of receivers) {
      expect(await received(terminal.id, kind)).toBe("");
    }
  }

  async function startFromToolbar(
    page: Page,
    ws: DictationWsHarness,
    scope: Page | Locator = page,
  ) {
    const chunk = ws.nextChunk();
    await visibleTestId(scope, "terminal-toolbar-dictation").click();
    await chunk;
  }

  // The route helper needs the desktop tab row, so open there, then go compact.
  async function openCompact(page: Page, terminal: TerminalInstance) {
    await harness.openTerminal(page, { terminalId: terminal.id });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();
  }

  // The compact switcher labels terminals by their command, so pick by position.
  async function selectCompactTab(page: Page, index: number) {
    await page
      .getByRole("button", { name: /Switch tabs/ })
      .filter({ visible: true })
      .click();
    await expect(page.getByText("Workspace tabs", { exact: true })).toBeVisible();
    const options = page
      .getByText("bracketed-receiver.cjs", { exact: true })
      .filter({ visible: true });
    await expect(options).toHaveCount(2);
    await options.nth(index).click();
    await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
  }

  async function selectTerminalTab(scope: Page | Locator, terminal: TerminalInstance) {
    await visibleTestId(scope, `workspace-tab-terminal_${terminal.id}`).click();
  }

  test("confirm pastes the transcript on one line with a trailing space and no Enter", async ({
    page,
  }) => {
    const ws = await setup(page);
    const bracketed = await createReceiver("bracketed", "dictation-bracketed");
    const raw = await createReceiver("raw", "dictation-raw");

    await harness.openTerminal(page, { terminalId: bracketed.id });
    await startFromToolbar(page, ws);
    await visibleTestId(page, "terminal-dictation-confirm").click();
    await expectReceived(bracketed.id, "bracketed", "first second ");
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();

    await selectTerminalTab(page, raw);
    await startFromToolbar(page, ws);
    await visibleTestId(page, "terminal-dictation-confirm").click();
    await expectReceived(raw.id, "raw", "first second ");
    expect(await received(bracketed.id, "bracketed")).toBe("first second ");
  });

  test("the dictation pill keeps the tab row usable in a narrow split", async ({ page }) => {
    const ws = await setup(page, { transcript: "narrow split words" });
    const left = await createReceiver("bracketed", "dictation-narrow-left");
    const right = await createReceiver("bracketed", "dictation-narrow-right");

    await harness.openTerminal(page, { terminalId: left.id });
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    await visibleTestId(page, `workspace-tab-terminal_${right.id}`).click();
    await runWorkspaceActionFromCommandCenter(page, "Move tab right");
    // Narrow enough that the pill's extra width decides whether the tab still fits.
    await page.setViewportSize({ width: 1000, height: 900 });
    const pane = splitChild(page, right);

    const tab = visibleTestId(pane, `workspace-tab-terminal_${right.id}`);
    const newTabButton = visibleTestId(pane, "workspace-new-tab-button");
    const inlineNewTabButton = pane
      .getByTestId("workspace-tabs-scroll")
      .getByTestId("workspace-new-tab-button");
    // Either the tab fits beside the inline new-tab button, or the row has switched to
    // its overflow fallback: tabs scroll and the new-tab button moves to the toolbar.
    // The button is never clipped by the tab scroller.
    const expectTabsFit = async () => {
      await expect(inlineNewTabButton).toHaveCount(1);
      await expect(newTabButton).toBeInViewport({ ratio: 1 });
      await expect(tab).toBeInViewport({ ratio: 1 });
    };

    await expectTabsFit();
    await startFromToolbar(page, ws, pane);
    await expect(visibleTestId(pane, "terminal-dictation-pill")).toBeVisible();
    await expect(newTabButton).toBeInViewport({ ratio: 1 });
    await expect(tab).toBeInViewport({ ratio: 1 });

    // The failed pill carries the error text, which leaves too little room for the tab.
    ws.failNextFinish("Synthetic transcription failure");
    await visibleTestId(pane, "terminal-dictation-confirm").click();
    await expect(visibleTestId(pane, "terminal-dictation-retry")).toBeVisible();
    await expect(inlineNewTabButton).toHaveCount(0);
    await expect(newTabButton).toBeInViewport({ ratio: 1 });

    await visibleTestId(pane, "terminal-dictation-retry").click();
    await expectReceived(right.id, "bracketed", "narrow split words ");
    await expect(visibleTestId(pane, "terminal-toolbar-dictation")).toBeVisible();
    await expectTabsFit();
  });

  test.describe("on macOS", () => {
    test.use({ userAgent: MAC_USER_AGENT });

    test("Cmd+D starts and then confirms dictation in the focused terminal", async ({ page }) => {
      const ws = await setup(page, { transcript: "shortcut words" });
      const terminal = await createReceiver("bracketed", "dictation-shortcut");

      await harness.openTerminal(page, { terminalId: terminal.id });
      const chunk = ws.nextChunk();
      await terminalInput(page).press("Meta+d");
      await expect(visibleTestId(page, "terminal-dictation-confirm")).toBeVisible();
      await chunk;
      await terminalInput(page).press("Meta+d");

      await expectReceived(terminal.id, "bracketed", "shortcut words ");
      await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    });

    test("Cmd+D goes to the terminal with keyboard focus, main pane or Explorer", async ({
      page,
    }) => {
      const ws = await setup(page, { transcript: "main pane words" });
      const explorerTerminal = await createReceiver("bracketed", "dictation-explorer");
      const mainTerminal = await createReceiver("bracketed", "dictation-main");

      await harness.openTerminal(page, { terminalId: explorerTerminal.id });
      await ensureExplorerSidebar(page);
      await dragTabIntoExplorer(page, explorerTerminal);
      const explorer = explorerSidebar(page);
      await expect(
        explorer.getByTestId(`workspace-tab-terminal_${explorerTerminal.id}`),
      ).toBeVisible();
      const main = page.getByTestId("workspace-pane-main");
      await selectTerminalTab(main, mainTerminal);
      await expect(explorer.getByTestId("terminal-surface")).toBeVisible();

      let chunk = ws.nextChunk();
      await terminalSurface(main).click();
      await terminalInput(main).press("Meta+d");
      await expect(visibleTestId(main, "terminal-dictation-confirm")).toBeVisible();
      await expect(explorer.getByTestId("terminal-dictation-confirm")).toHaveCount(0);
      await chunk;
      await terminalInput(main).press("Meta+d");
      await expectReceived(mainTerminal.id, "bracketed", "main pane words ");
      await expectNothingReceived(page, [explorerTerminal, "bracketed"]);

      ws.setTranscript("explorer words");
      chunk = ws.nextChunk();
      await terminalSurface(explorer).click();
      await terminalInput(explorer).press("Meta+d");
      await expect(visibleTestId(explorer, "terminal-dictation-confirm")).toBeVisible();
      await expect(main.getByTestId("terminal-dictation-confirm")).toHaveCount(0);
      await chunk;
      await terminalInput(explorer).press("Meta+d");
      await expectReceived(explorerTerminal.id, "bracketed", "explorer words ");
      expect(await received(mainTerminal.id, "bracketed")).toBe("main pane words ");
    });

    test("Cmd+D records only in the focused split pane", async ({ page }) => {
      const ws = await setup(page, { transcript: "right pane words" });
      const left = await createReceiver("bracketed", "dictation-split-left");
      const right = await createReceiver("bracketed", "dictation-split-right");

      await harness.openTerminal(page, { terminalId: left.id });
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      await visibleTestId(page, `workspace-tab-terminal_${right.id}`).click();
      await runWorkspaceActionFromCommandCenter(page, "Move tab right");
      const leftPane = splitChild(page, left);
      const rightPane = splitChild(page, right);
      await expect(terminalInput(leftPane)).toHaveCount(1);
      await expect(terminalInput(rightPane)).toHaveCount(1);

      const chunk = ws.nextChunk();
      await terminalSurface(rightPane).click();
      await terminalInput(rightPane).press("Meta+d");
      await expect(visibleTestId(rightPane, "terminal-dictation-confirm")).toBeVisible();
      await expect(leftPane.getByTestId("terminal-dictation-confirm")).toHaveCount(0);
      await chunk;
      await terminalInput(rightPane).press("Meta+d");

      await expectReceived(right.id, "bracketed", "right pane words ");
      await expectNothingReceived(page, [left, "bracketed"]);
    });
  });

  test("Ctrl+D off macOS reaches the PTY as EOF and starts nothing", async ({ page }) => {
    // Chromium keeps the host's navigator.platform unless the override sets it too.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setUserAgentOverride", {
      userAgent: LINUX_USER_AGENT,
      platform: "Linux x86_64",
    });
    const ws = await setup(page);
    const terminal = await createReceiver("raw", "dictation-ctrl-d");

    await harness.openTerminal(page, { terminalId: terminal.id });
    await terminalInput(page).press("Control+d");

    await expectReceived(terminal.id, "raw", "\u0004");
    expect(ws.streamStarts()).toBe(0);
    expect((await microphoneStats(page)).getUserMediaCalls).toBe(0);
    await expect(page.getByTestId("terminal-dictation-confirm")).toHaveCount(0);
  });

  test("switching the pane to another terminal while recording stops it and delivers nothing", async ({
    page,
  }) => {
    const ws = await setup(page);
    const first = await createReceiver("bracketed", "dictation-switch-a");
    const second = await createReceiver("bracketed", "dictation-switch-b");

    await harness.openTerminal(page, { terminalId: first.id });
    await startFromToolbar(page, ws);
    await selectTerminalTab(page, second);

    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    await expect(
      page.getByTestId("terminal-dictation-cancel").filter({ visible: true }),
    ).toHaveCount(0);
    await expectMicrophoneStat(page, "trackStops", 1);
    const chunksAfterSwitch = ws.chunks();
    const startsAfterSwitch = ws.streamStarts();
    await expectNothingReceived(page, [first, "bracketed"], [second, "bracketed"]);
    expect(ws.chunks()).toBe(chunksAfterSwitch);
    expect(ws.streamStarts()).toBe(startsAfterSwitch);

    await selectTerminalTab(page, first);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    await expect(
      page.getByTestId("terminal-dictation-cancel").filter({ visible: true }),
    ).toHaveCount(0);
  });

  test("switching the pane to another terminal while processing drops the late transcript", async ({
    page,
  }) => {
    const ws = await setup(page);
    const first = await createReceiver("bracketed", "dictation-processing-a");
    const second = await createReceiver("bracketed", "dictation-processing-b");

    await harness.openTerminal(page, { terminalId: first.id });
    await startFromToolbar(page, ws);
    ws.holdFinal();
    await visibleTestId(page, "terminal-dictation-confirm").click();
    await expect(visibleTestId(page, "terminal-dictation-confirm")).toHaveCount(0);
    await expect(visibleTestId(page, "terminal-dictation-cancel")).toBeVisible();
    await selectTerminalTab(page, second);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    ws.releaseFinal();

    await expectNothingReceived(page, [first, "bracketed"], [second, "bracketed"]);
  });

  // Fails the first confirm, then retries with the final reply held, so the retry is
  // still processing when the test acts on it.
  async function startHeldRetry(page: Page, ws: DictationWsHarness) {
    ws.failNextFinish("Synthetic transcription failure");
    await startFromToolbar(page, ws);
    await visibleTestId(page, "terminal-dictation-confirm").click();
    await expect(visibleTestId(page, "terminal-dictation-retry")).toBeVisible();
    ws.holdFinal();
    await visibleTestId(page, "terminal-dictation-retry").click();
    await expect(visibleTestId(page, "terminal-dictation-retry")).toHaveCount(0);
    await expect.poll(() => ws.hasHeldFinal()).toBe(true);
  }

  test("cancelling a retry drops its late transcript", async ({ page }) => {
    const ws = await setup(page, { transcript: "cancelled retry words" });
    const terminal = await createReceiver("bracketed", "dictation-retry-cancel");

    await harness.openTerminal(page, { terminalId: terminal.id });
    await startHeldRetry(page, ws);
    await visibleTestId(page, "terminal-dictation-cancel").click();
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    ws.releaseFinal();

    await expectNothingReceived(page, [terminal, "bracketed"]);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
  });

  test("hiding a retrying terminal and returning before its reply drops the transcript", async ({
    page,
  }) => {
    const ws = await setup(page, { transcript: "hidden retry words" });
    const first = await createReceiver("bracketed", "dictation-retry-hide-a");
    const second = await createReceiver("bracketed", "dictation-retry-hide-b");

    await harness.openTerminal(page, { terminalId: first.id });
    await startHeldRetry(page, ws);
    await selectTerminalTab(page, second);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    // Back on the retained pane, which is presented and still the recording owner.
    await selectTerminalTab(page, first);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    ws.releaseFinal();

    await expectNothingReceived(page, [first, "bracketed"], [second, "bracketed"]);
  });

  test.describe("on compact web on macOS", () => {
    test.use({ userAgent: MAC_USER_AGENT });

    // Compact web turns shortcuts off except terminal dictation's Cmd+D.
    test("Cmd+D starts and then confirms dictation in the focused terminal", async ({ page }) => {
      const ws = await setup(page, { transcript: "compact shortcut words" });
      const terminal = await createReceiver("bracketed", "dictation-compact-shortcut");

      await openCompact(page, terminal);
      await terminalSurface(page).click();
      const chunk = ws.nextChunk();
      await terminalInput(page).press("Meta+d");
      await expect(visibleTestId(page, "terminal-dictation-overlay")).toBeVisible();
      await chunk;
      await expect(terminalInput(page)).toBeFocused();
      await terminalInput(page).press("Meta+d");

      await expectReceived(terminal.id, "bracketed", "compact shortcut words ");
      await expect(page.getByTestId("terminal-dictation-overlay")).toHaveCount(0);
      await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();
    });
  });

  test.describe("on compact web", () => {
    test("the key-bar mic shows the overlay and confirm delivers", async ({ page }) => {
      const ws = await setup(page, { transcript: "compact words" });
      const terminal = await createReceiver("bracketed", "dictation-compact-confirm");

      await openCompact(page, terminal);
      const chunk = ws.nextChunk();
      await visibleTestId(page, "terminal-dictation").click();
      const overlay = visibleTestId(page, "terminal-dictation-overlay");
      await expect(overlay).toBeVisible();
      await expect(visibleTestId(page, "terminal-dictation")).toHaveCount(0);
      await expect(
        overlay.getByRole("button", { name: "Insert transcription and send", exact: true }),
      ).toHaveCount(0);
      await chunk;
      await overlay.getByRole("button", { name: "Insert transcription", exact: true }).click();

      await expectReceived(terminal.id, "bracketed", "compact words ");
      await expect(page.getByTestId("terminal-dictation-overlay")).toHaveCount(0);
      await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();
    });

    test("switching tabs while recording from the key bar stops it and delivers nothing", async ({
      page,
    }) => {
      const ws = await setup(page);
      const first = await createReceiver("bracketed", "dictation-compact-a");
      const second = await createReceiver("bracketed", "dictation-compact-b");

      await openCompact(page, first);
      const chunk = ws.nextChunk();
      await visibleTestId(page, "terminal-dictation").click();
      await expect(visibleTestId(page, "terminal-dictation-overlay")).toBeVisible();
      await chunk;

      await selectCompactTab(page, 1);
      await expectMicrophoneStat(page, "trackStops", 1);
      await expectNothingReceived(page, [first, "bracketed"], [second, "bracketed"]);

      await selectCompactTab(page, 0);
      await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();
      await expect(
        page.getByTestId("terminal-dictation-overlay").filter({ visible: true }),
      ).toHaveCount(0);
      expect(await received(first.id, "bracketed")).toBe("");
    });

    test("a failed dictation keeps the overlay with retry and discard", async ({ page }) => {
      const ws = await setup(page, { transcript: "retried words" });
      const terminal = await createReceiver("bracketed", "dictation-compact-failure");

      await openCompact(page, terminal);
      const overlay = visibleTestId(page, "terminal-dictation-overlay");

      ws.failNextFinish("Synthetic transcription failure");
      let chunk = ws.nextChunk();
      await visibleTestId(page, "terminal-dictation").click();
      await chunk;
      await overlay.getByRole("button", { name: "Insert transcription", exact: true }).click();
      await expect(overlay).toContainText("Dictation failed: Synthetic transcription failure");
      await overlay.getByRole("button", { name: "Retry dictation", exact: true }).click();
      await expectReceived(terminal.id, "bracketed", "retried words ");
      await expect(page.getByTestId("terminal-dictation-overlay")).toHaveCount(0);
      await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();

      ws.failNextFinish("Synthetic transcription failure");
      chunk = ws.nextChunk();
      await visibleTestId(page, "terminal-dictation").click();
      await chunk;
      await overlay.getByRole("button", { name: "Insert transcription", exact: true }).click();
      await expect(overlay).toContainText("Dictation failed: Synthetic transcription failure");
      await overlay.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await expect(page.getByTestId("terminal-dictation-overlay")).toHaveCount(0);
      await expect(visibleTestId(page, "terminal-dictation")).toBeVisible();
      await page.waitForTimeout(1_500);
      expect(await received(terminal.id, "bracketed")).toBe("retried words ");
    });
  });

  for (const scenario of [
    {
      name: "a host without the dictation capability asks to update the host",
      capability: "missing" as const,
      message: "Update the host to use dictation in terminals.",
    },
    {
      name: "disabled dictation with an empty reason shows the fallback message",
      capability: { enabled: false, reason: "  " },
      message: "Dictation is not available on this host.",
    },
    {
      name: "disabled dictation shows the host's reason",
      capability: { enabled: false, reason: "No speech model installed" },
      message: "No speech model installed",
    },
  ]) {
    test(scenario.name, async ({ page }) => {
      const ws = await setup(page, { capability: scenario.capability });
      const terminal = await createReceiver("bracketed", "dictation-capability");

      await harness.openTerminal(page, { terminalId: terminal.id });
      await visibleTestId(page, "terminal-toolbar-dictation").click();

      await expect(page.getByTestId("app-toast-message")).toHaveText(scenario.message);
      await expect(page.getByTestId("terminal-dictation-cancel")).toHaveCount(0);
      expect((await microphoneStats(page)).getUserMediaCalls).toBe(0);
      expect(ws.streamStarts()).toBe(0);
    });
  }

  test("hiding a terminal while its microphone is still being acquired releases it", async ({
    page,
  }) => {
    const ws = await setup(page);
    const first = await createReceiver("bracketed", "dictation-held-hide-a");
    const second = await createReceiver("bracketed", "dictation-held-hide-b");

    await harness.openTerminal(page, { terminalId: first.id });
    await holdMicrophone(page);
    await visibleTestId(page, "terminal-toolbar-dictation").click();
    await expectMicrophoneStat(page, "getUserMediaCalls", 1);
    await expect(visibleTestId(page, "terminal-dictation-cancel")).toBeVisible();

    await selectTerminalTab(page, second);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    await releaseMicrophone(page);

    await expectMicrophoneStat(page, "trackStops", 1);
    await expectNothingReceived(page, [first, "bracketed"], [second, "bracketed"]);
    expect(ws.streamStarts()).toBe(0);
    expect(ws.chunks()).toBe(0);

    await selectTerminalTab(page, first);
    await expect(visibleTestId(page, "terminal-toolbar-dictation")).toBeVisible();
    await expect(
      page.getByTestId("terminal-dictation-cancel").filter({ visible: true }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("terminal-dictation-confirm").filter({ visible: true }),
    ).toHaveCount(0);
  });

  test("closing a terminal while its microphone is still being acquired releases it", async ({
    page,
  }) => {
    const ws = await setup(page);
    const first = await createReceiver("bracketed", "dictation-held-close-a");
    const second = await createReceiver("bracketed", "dictation-held-close-b");

    await harness.openTerminal(page, { terminalId: first.id });
    await holdMicrophone(page);
    await visibleTestId(page, "terminal-toolbar-dictation").click();
    await expectMicrophoneStat(page, "getUserMediaCalls", 1);

    // Closing the terminal closes its tab, so its pane unmounts with the start pending.
    await harness.killTerminal(first.id);
    await expect(page.getByTestId(`workspace-tab-terminal_${first.id}`)).toHaveCount(0);
    await releaseMicrophone(page);

    await expectMicrophoneStat(page, "trackStops", 1);
    await expectNothingReceived(page, [second, "bracketed"]);
    expect(ws.streamStarts()).toBe(0);
    expect(ws.chunks()).toBe(0);
  });
});
