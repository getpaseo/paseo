import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { holdFileUploadResponse } from "../support/helpers/file-upload-gate";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { installLocalDesktopHost } from "../support/helpers/local-desktop-host";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText, waitForTerminalContent } from "../support/helpers/terminal-perf";

const OSC11_CAPTURE_SCRIPT = `
let captured = Buffer.alloc(0);

function finish() {
  process.stdout.write("PASEO_OSC11_CAPTURE:" + JSON.stringify(captured.toString("latin1")) + "\\n");
  process.exit(0);
}

process.stdout.write("\\x1b]11;?\\x07");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  captured = Buffer.concat([captured, chunk]);
});
setTimeout(finish, 700);
`;

const TERMINAL_PALETTE_PROBE_SCRIPT = `
process.stdin.setRawMode(true);
process.stdin.resume();
const mode = process.argv[2];
let buf = "";
const timer = setTimeout(() => {
  process.stdout.write("PROBE_TIMEOUT:" + mode + ":" + buf.replace(/\\x1b/g, "ESC") + "\\n");
  process.exit(2);
}, 5000);

if (mode === "osc") {
  const code = process.argv[3];
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("binary");
    const match = buf.match(new RegExp("\\\\x1b\\\\]" + code + ";rgb:[0-9a-f/]+\\\\x1b\\\\\\\\"));
    if (!match) return;
    clearTimeout(timer);
    process.stdout.write("OSC_COLOR_OK:" + code + ":" + match[0].replace(/\\x1b/g, "ESC") + "\\n");
    process.exit(0);
  });
  process.stdout.write("\\x1b]" + code + ";?\\x07");
} else if (mode === "dsr996") {
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("binary");
    const match = buf.match(/\\x1b\\[\\?997;([12])n/);
    if (!match) return;
    clearTimeout(timer);
    process.stdout.write("DSR996_OK:" + match[1] + "\\n");
    process.exit(0);
  });
  process.stdout.write("\\x1b[?996n");
} else if (mode === "watch2031") {
  clearTimeout(timer);
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("binary");
    if (buf.includes("Q")) {
      process.stdout.write("\\x1b[?2031lWATCH2031_DONE\\n");
      process.exit(0);
    }
    let match;
    while ((match = buf.match(/\\x1b\\[\\?997;([12])n/))) {
      process.stdout.write("WATCH2031_EVENT:" + match[1] + "\\n");
      buf = buf.slice(match.index + match[0].length);
    }
  });
  process.stdout.write("\\x1b[?2031hWATCH2031_READY\\n");
}
`;

const TERMINAL_PALETTE_SCENARIOS = {
  light: {
    label: "Light",
    colorFgBg: "0;15",
    schemeCode: "2",
    colors: {
      10: "rgb:1a1a/1a1a/1e1e",
      11: "rgb:ffff/ffff/ffff",
      12: "rgb:1a1a/1a1a/1e1e",
    },
  },
  dark: {
    label: "Dark",
    colorFgBg: "15;0",
    schemeCode: "1",
    colors: {
      10: "rgb:fafa/fafa/fafa",
      11: "rgb:1818/1b1b/1a1a",
      12: "rgb:fafa/fafa/fafa",
    },
  },
} as const;

type TerminalPaletteScenario =
  (typeof TERMINAL_PALETTE_SCENARIOS)[keyof typeof TERMINAL_PALETTE_SCENARIOS];

async function selectAppThemeInApp(
  page: Page,
  label: TerminalPaletteScenario["label"],
): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeRadio = page.getByRole("radio", { name: label, exact: true });
  await themeRadio.click();
  await expect(themeRadio).toBeChecked();
  await clickSettingsBackToWorkspace(page);
}

function collectBrowserOsc11Replies(page: Page): string[] {
  const replies: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("latin1");
      if (text.includes("]11;rgb:")) {
        replies.push(text);
      }
    });
  });
  return replies;
}

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

// A TUI stand-in: turns on bracketed paste, reads every quoted path in each
// bracketed paste, and echoes typed lines, so the PTY output proves what reached
// the terminal and where the file was read from.
const FILE_RECEIVER_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
let buffer = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004hFILE_RECEIVER_READY\r\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const paste = /\x1b\[200~([^]*?)\x1b\[201~/.exec(buffer);
    if (!paste) break;
    const pasted = JSON.stringify(paste[1]).replace(
      /\s/g,
      (space) => "\\u" + space.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    process.stdout.write("PASTED:" + pasted + "\r\n");
    for (const [, path] of paste[1].matchAll(/'([^']*)'/g)) {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
      const location = /[\\/]uploads[\\/]upload_/.test(path) ? "upload" : "local";
      process.stdout.write("FILE_READ:" + digest + ":" + location + "\r\n");
    }
    buffer = buffer.slice(0, paste.index) + buffer.slice(paste.index + paste[0].length);
  }
  if (buffer.includes("\x03")) {
    process.stdout.write("INTERRUPTED\r\n");
    buffer = buffer.replaceAll("\x03", "");
  }
  const enter = buffer.indexOf("\r");
  if (enter >= 0 && !buffer.includes("'")) {
    process.stdout.write("TYPED:" + buffer.slice(0, enter) + "\r\n");
    buffer = buffer.slice(enter + 1);
  }
});
`;

function pngBytes(seed: number): Buffer {
  return Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), Buffer.from([seed])]);
}

function fileRead(bytes: Buffer, location: "upload" | "local"): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `FILE_READ:${digest}:${location}`;
}

// Inactive terminal tabs retain their surfaces, and another page opening a terminal in
// the same workspace adds a tab here too. Only the selected tab's surface is visible.
function terminalSurface(page: Page) {
  return page.getByTestId("terminal-surface").filter({ visible: true });
}

function terminalInput(page: Page) {
  return terminalSurface(page).locator(".xterm-helper-textarea");
}

async function pasteImage(page: Page, bytes: Buffer): Promise<void> {
  await terminalInput(page).evaluate(
    (element, data) => {
      (element as HTMLTextAreaElement).focus();
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    [...bytes],
  );
}

interface DroppedFile {
  name: string;
  type: string;
  bytes: Buffer;
}

async function dragTransfer(page: Page, files: DroppedFile[]) {
  return await page.evaluateHandle(
    (entries) => {
      const dataTransfer = new DataTransfer();
      for (const entry of entries) {
        dataTransfer.items.add(
          new File([new Uint8Array(entry.bytes)], entry.name, { type: entry.type }),
        );
      }
      return dataTransfer;
    },
    files.map((file) => ({ ...file, bytes: [...file.bytes] })),
  );
}

async function dragFilesOver(page: Page, files: DroppedFile[]): Promise<void> {
  const dataTransfer = await dragTransfer(page, files);
  await terminalInput(page).dispatchEvent("dragenter", { dataTransfer });
  await terminalInput(page).dispatchEvent("dragover", { dataTransfer });
  await dataTransfer.dispose();
}

async function dropFiles(page: Page, files: DroppedFile[]): Promise<void> {
  const dataTransfer = await dragTransfer(page, files);
  await terminalInput(page).dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

/** The shared "Drop files here" overlay of the zone around the terminal. */
function terminalDropOverlay(page: Page) {
  return terminalSurface(page)
    .locator("xpath=ancestor::*[.//*[@data-testid='file-drop-backdrop']][1]")
    .getByTestId("file-drop-backdrop");
}

/**
 * Makes the app treat the e2e daemon as the desktop app's own daemon, so dropped
 * files resolve to paths inside `directory` instead of uploading.
 */
async function typeLine(page: Page, text: string): Promise<void> {
  await terminalInput(page).pressSequentially(text);
  await terminalInput(page).press("Enter");
}

test.describe("Terminal protocol queries", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
    await writeFile(path.join(harness.tempRepo.path, "osc11-capture.cjs"), OSC11_CAPTURE_SCRIPT);
    await writeFile(
      path.join(harness.tempRepo.path, "palette-probe.cjs"),
      TERMINAL_PALETTE_PROBE_SCRIPT,
    );
    await writeFile(path.join(harness.tempRepo.path, "file-receiver.cjs"), FILE_RECEIVER_SCRIPT);
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("does not send browser OSC 11 color-query replies back to the PTY", async ({ page }) => {
    const browserOscReplies = collectBrowserOsc11Replies(page);

    const terminalInstance = await harness.createTerminal({ name: "osc11-query" });
    try {
      await harness.openTerminal(page, { terminalId: terminalInstance.id });
      await harness.setupPrompt(page);

      const terminal = harness.terminalSurface(page);
      await terminal.pressSequentially("node osc11-capture.cjs\n", { delay: 0 });

      await waitForTerminalContent(page, (text) => text.includes("PASEO_OSC11_CAPTURE:"), 10_000);
      await page.waitForTimeout(500);

      const text = await getTerminalBufferText(page);
      const captureLine =
        text.split("\n").find((line) => line.includes("PASEO_OSC11_CAPTURE:")) ?? "";
      const capturedMatches = captureLine.match(/\]11;rgb:[0-9a-f/]+/g) ?? [];

      expect(capturedMatches).toHaveLength(1);
      expect(browserOscReplies).toEqual([]);
      const afterCapture = text.slice(text.indexOf("PASEO_OSC11_CAPTURE:") + captureLine.length);
      expect(afterCapture).not.toContain("rgb:");
    } finally {
      await harness.killTerminal(terminalInstance.id);
    }
  });

  test("reports Light and Dark palettes through OSC 10/11/12, COLORFGBG, DSR 996/997, and live DEC 2031 toggles", async ({
    page,
  }) => {
    const createAppTerminal = async (): Promise<string> => {
      const existing = await harness.client.listTerminals(harness.tempRepo.path, undefined, {
        workspaceId: harness.workspaceId,
      });
      const knownIds = new Set(existing.terminals.map((entry) => entry.id));
      await clickNewTerminal(page);
      const terminalId = await waitForCreatedTerminal(harness, knownIds);
      const surface = terminalSurface(page);
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.click();
      const readyTag = `READY_${Date.now()}`;
      await surface.pressSequentially(`echo ${readyTag}\n`, { delay: 0 });
      await expectTerminalOutput(terminalId, readyTag);
      return terminalId;
    };

    const runPaletteChecks = async (
      terminalId: string,
      scenario: TerminalPaletteScenario,
      options: { checkColorFgBg: boolean },
    ): Promise<void> => {
      const surface = terminalSurface(page);
      await surface.click();
      if (options.checkColorFgBg) {
        await surface.pressSequentially('echo "CFGBG=$COLORFGBG"\n', { delay: 0 });
        await expectTerminalOutput(terminalId, `CFGBG=${scenario.colorFgBg}`);
      }
      for (const code of [10, 11, 12] as const) {
        await surface.pressSequentially(`${process.execPath} palette-probe.cjs osc ${code}\n`, {
          delay: 0,
        });
        await expectTerminalOutput(
          terminalId,
          `OSC_COLOR_OK:${code}:ESC]${code};${scenario.colors[code]}ESC\\`,
        );
      }
      await surface.pressSequentially(`${process.execPath} palette-probe.cjs dsr996\n`, {
        delay: 0,
      });
      await expectTerminalOutput(terminalId, `DSR996_OK:${scenario.schemeCode}`);
    };

    // 1. Open workspace once, switch to Light in-app, and create a fresh Light terminal.
    await gotoWorkspace(page, harness.workspaceId);
    await selectAppThemeInApp(page, "Light");
    const lightTerminalId = await createAppTerminal();
    let darkTerminalId: string | null = null;
    try {
      await runPaletteChecks(lightTerminalId, TERMINAL_PALETTE_SCENARIOS.light, {
        checkColorFgBg: true,
      });

      // 2. Start DEC 2031 watcher in that running Light terminal, then toggle Light -> Dark -> Light.
      await terminalSurface(page).pressSequentially(
        `${process.execPath} palette-probe.cjs watch2031\n`,
        { delay: 0 },
      );
      await expectTerminalOutput(lightTerminalId, "WATCH2031_READY");

      await selectAppThemeInApp(page, "Dark");
      await expectTerminalOutput(lightTerminalId, "WATCH2031_EVENT:1");

      await selectAppThemeInApp(page, "Light");
      await expectTerminalOutput(lightTerminalId, "WATCH2031_EVENT:2");

      // Stop watcher, toggle to Dark, and verify live OSC 10/11/12 + DSR 996 update on the same PTY.
      await terminalSurface(page).click();
      await terminalSurface(page).pressSequentially("Q", { delay: 0 });
      await expectTerminalOutput(lightTerminalId, "WATCH2031_DONE");

      await selectAppThemeInApp(page, "Dark");
      await runPaletteChecks(lightTerminalId, TERMINAL_PALETTE_SCENARIOS.dark, {
        checkColorFgBg: false,
      });

      // 3. Fresh Dark terminal reports Dark OSC 10/11/12, COLORFGBG=15;0, and DSR 996 -> dark (1).
      darkTerminalId = await createAppTerminal();
      await runPaletteChecks(darkTerminalId, TERMINAL_PALETTE_SCENARIOS.dark, {
        checkColorFgBg: true,
      });
    } finally {
      await harness.killTerminal(lightTerminalId);
      if (darkTerminalId) {
        await harness.killTerminal(darkTerminalId);
      }
    }
  });

  async function openFileReceiver(page: Page, name: string) {
    const terminal = await harness.createTerminal({
      name,
      command: process.execPath,
      args: ["file-receiver.cjs"],
    });
    await harness.openTerminal(page, { terminalId: terminal.id });
    await expectTerminalOutput(terminal.id, "FILE_RECEIVER_READY");
    return terminal;
  }

  // Reads the PTY itself, so output from one pane cannot satisfy another's check.
  async function terminalOutput(terminalId: string): Promise<string> {
    const capture = await harness.client.captureTerminal(terminalId);
    return capture.lines.join("").replace(/\s/g, "");
  }

  async function expectTerminalOutput(terminalId: string, text: string): Promise<void> {
    await expect.poll(() => terminalOutput(terminalId), { timeout: 10_000 }).toContain(text);
  }

  // Every bracketed paste body the receiver consumed, in order and joined: what a
  // shell would read as one command line.
  async function pastedText(terminalId: string): Promise<string> {
    const output = await terminalOutput(terminalId);
    return [...output.matchAll(/PASTED:("(?:[^"\\]|\\.)*")/g)]
      .map(([, json]) => JSON.parse(json) as string)
      .join("");
  }

  // Exactly one ASCII space after each quoted path and nothing else between them,
  // so the paths stay separate shell words.
  async function expectSeparatePastedPaths(terminalId: string): Promise<void> {
    await expect.poll(() => pastedText(terminalId)).toMatch(/^'[^']+' '[^']+' $/);
  }

  test("pastes images from two panes into their own terminals as uploaded host files", async ({
    page,
  }) => {
    const secondPage = await page.context().newPage();
    const first = await openFileReceiver(page, "image-paste-a");
    const second = await openFileReceiver(secondPage, "image-paste-b");
    try {
      await Promise.all([pasteImage(page, pngBytes(1)), pasteImage(secondPage, pngBytes(2))]);

      await expectTerminalOutput(first.id, fileRead(pngBytes(1), "upload"));
      await expectTerminalOutput(second.id, fileRead(pngBytes(2), "upload"));
      expect(await terminalOutput(first.id)).not.toContain(fileRead(pngBytes(2), "upload"));
      expect(await terminalOutput(second.id)).not.toContain(fileRead(pngBytes(1), "upload"));
    } finally {
      await secondPage.close();
      await harness.killTerminal(first.id);
      await harness.killTerminal(second.id);
    }
  });

  test("uploads dropped files of any type when the host is another machine", async ({ page }) => {
    const terminal = await openFileReceiver(page, "file-drop-remote");
    const files = [
      { name: "shot.png", type: "image/png", bytes: pngBytes(3) },
      { name: "notes.txt", type: "text/plain", bytes: Buffer.from("remote notes") },
    ];
    try {
      await dragFilesOver(page, files);
      await expect(terminalDropOverlay(page)).toHaveCSS("opacity", "1");
      await expect(terminalDropOverlay(page)).toHaveText("Drop files here");

      await dropFiles(page, files);
      await expect(terminalDropOverlay(page)).toHaveCSS("opacity", "0");

      await expectTerminalOutput(terminal.id, fileRead(pngBytes(3), "upload"));
      await expectTerminalOutput(terminal.id, fileRead(Buffer.from("remote notes"), "upload"));
      await expectSeparatePastedPaths(terminal.id);
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("keeps the paths of two consecutive drops to another machine apart", async ({ page }) => {
    const terminal = await openFileReceiver(page, "file-drop-remote-twice");
    const first = { name: "first.png", type: "image/png", bytes: pngBytes(10) };
    const second = { name: "second.txt", type: "text/plain", bytes: Buffer.from("second drop") };
    try {
      await dropFiles(page, [first]);
      await expectTerminalOutput(terminal.id, fileRead(first.bytes, "upload"));
      await dropFiles(page, [second]);
      await expectTerminalOutput(terminal.id, fileRead(second.bytes, "upload"));

      await expectSeparatePastedPaths(terminal.id);
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("pastes dropped files' own paths when the host is this machine", async ({ page }) => {
    const files = [
      { name: "local-shot.png", type: "image/png", bytes: pngBytes(9) },
      { name: "local-notes.txt", type: "text/plain", bytes: Buffer.from("local notes") },
    ];
    for (const file of files) {
      await writeFile(path.join(harness.tempRepo.path, file.name), file.bytes);
    }
    await installLocalDesktopHost(page, harness.tempRepo.path);
    const terminal = await openFileReceiver(page, "file-drop-local");
    try {
      await dropFiles(page, files);

      await expectTerminalOutput(terminal.id, fileRead(pngBytes(9), "local"));
      await expectTerminalOutput(terminal.id, fileRead(Buffer.from("local notes"), "local"));
      expect(await terminalOutput(terminal.id)).not.toContain(":upload");
      await expect(page.getByTestId("terminal-file-uploading")).toHaveCount(0);
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("lands image pastes in gesture order while typing stays live", async ({ page }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openFileReceiver(page, "image-order");
    try {
      await pasteImage(page, pngBytes(4));
      await upload.waitUntilHeld();
      await pasteImage(page, pngBytes(5));
      await expect(page.getByTestId("terminal-file-uploading")).toHaveText("Uploading file…");

      await typeLine(page, "describe");
      await expectTerminalOutput(terminal.id, "TYPED:describe");

      upload.release();
      await expectTerminalOutput(terminal.id, fileRead(pngBytes(5), "upload"));
      const output = await terminalOutput(terminal.id);
      expect(output.indexOf(fileRead(pngBytes(4), "upload"))).toBeGreaterThanOrEqual(0);
      expect(output.indexOf(fileRead(pngBytes(4), "upload"))).toBeLessThan(
        output.indexOf(fileRead(pngBytes(5), "upload")),
      );
      await expect(page.getByTestId("terminal-file-uploading")).toHaveCount(0);
      await expect(page.getByTestId("app-toast-message")).toHaveText("File uploaded");
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("Ctrl+C abandons an image paste that is still uploading", async ({ page }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openFileReceiver(page, "image-cancel");
    try {
      await pasteImage(page, pngBytes(6));
      await upload.waitUntilHeld();

      await terminalInput(page).press("Control+c");
      await expectTerminalOutput(terminal.id, "INTERRUPTED");
      await expect(page.getByTestId("terminal-file-uploading")).toHaveCount(0);
      upload.release();

      await pasteImage(page, pngBytes(7));
      await expectTerminalOutput(terminal.id, fileRead(pngBytes(7), "upload"));
      expect(await terminalOutput(terminal.id)).not.toContain(fileRead(pngBytes(6), "upload"));
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("a disconnect during upload reports one failure and input keeps working", async ({
    page,
  }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openFileReceiver(page, "image-disconnect");
    try {
      await pasteImage(page, pngBytes(8));
      await upload.waitUntilHeld();

      await upload.disconnect();
      await expect(page.getByTestId("app-toast-message")).toHaveText(
        "Failed to paste file: Host is not connected",
      );

      await typeLine(page, "after");
      await expectTerminalOutput(terminal.id, "TYPED:after");
      expect(await terminalOutput(terminal.id)).not.toContain(fileRead(pngBytes(8), "upload"));
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });
});
