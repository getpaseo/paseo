import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { holdFileUploadResponse } from "../support/helpers/file-upload-gate";
import { installLocalDesktopHost } from "../support/helpers/local-desktop-host";
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
  if (captured.includes(Buffer.from("rgb:"))) {
    finish();
  }
});
setTimeout(finish, 700);
`;

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
    await writeFile(path.join(harness.tempRepo.path, "file-receiver.cjs"), FILE_RECEIVER_SCRIPT);
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("does not send browser OSC 11 color-query replies back to the PTY", async ({ page }) => {
    const terminalInstance = await harness.createTerminal({ name: "osc11-query" });
    try {
      await harness.openTerminal(page, { terminalId: terminalInstance.id });
      await harness.setupPrompt(page);

      const terminal = harness.terminalSurface(page);
      await terminal.pressSequentially("node osc11-capture.cjs\n", { delay: 0 });

      await waitForTerminalContent(page, (text) => text.includes("PASEO_OSC11_CAPTURE:"), 10_000);
      await page.waitForTimeout(500);

      const text = await getTerminalBufferText(page);

      expect(text).toContain("rgb:0b0b/0b0b/0b0b");
      expect(text).not.toContain("rgb:ffff/ffff/ffff");
    } finally {
      await harness.killTerminal(terminalInstance.id);
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
