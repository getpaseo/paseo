import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
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

// Real PTY consumer: acknowledgement deliberately precedes file consumption, so
// a page reload/reconnect cannot masquerade as proof that the image was read.
const IMAGE_RECEIVER_SCRIPT = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
let pending = '', imagePath;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b[?2004hIMAGE_RECEIVER_READY\\r\\n');
process.stdin.on('data', chunk => {
  pending += chunk.toString();
  const end = pending.indexOf('\\x1b[201~');
  if (end >= 0) {
    const start = pending.indexOf('\\x1b[200~');
    const reference = pending.slice(start + 6, end);
    if (start < 0 || reference.length < 3) throw new Error('Empty image file reference');
    imagePath = reference.startsWith('file:') ? fileURLToPath(reference) : reference.slice(1, -1);
    pending = '';
    process.stdout.write('IMAGE_STAGED\\r\\n');
  } else if (imagePath && pending.includes('r')) {
    const bytes = fs.readFileSync(imagePath);
    const mode = fs.statSync(imagePath).mode & 0o777;
    process.stdout.write('IMAGE_READ:' + crypto.createHash('sha256').update(bytes).digest('hex') + ':' + mode.toString(8) + '\\r\\n');
    pending = '';
  }
});
`;

async function expectCapturedImageOutput(
  harness: TerminalE2EHarness,
  terminalId: string,
  output: string,
) {
  // The browser's __paseoTerminal hook is global and can point at another mounted
  // tab. Read the exact PTY to prove uploads cannot cross terminal boundaries.
  await expect
    .poll(
      async () => {
        const capture = await harness.client.captureTerminal(terminalId);
        return capture.lines.join("").replace(/\s/g, "");
      },
      { timeout: 10_000 },
    )
    .toContain(output);
}

async function pasteImageInTerminal(
  target: Page,
  harness: TerminalE2EHarness,
  terminalId: string,
  payload: Buffer,
) {
  await harness.openTerminal(target, { terminalId: terminalId });
  await expectCapturedImageOutput(harness, terminalId, "IMAGE_RECEIVER_READY");
  await target.locator('[data-testid="terminal-surface"] .xterm-helper-textarea').evaluate(
    (element, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    [...payload],
  );
  await expectCapturedImageOutput(harness, terminalId, "IMAGE_STAGED");
}

test.describe("Terminal protocol queries", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
    await writeFile(path.join(harness.tempRepo.path, "osc11-capture.cjs"), OSC11_CAPTURE_SCRIPT);
    await writeFile(path.join(harness.tempRepo.path, "image-receiver.cjs"), IMAGE_RECEIVER_SCRIPT);
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

  test("routes two pane image pastes to private files that survive browser reconnect", async ({
    page,
  }) => {
    const secondPage = await page.context().newPage();
    const terminals = await Promise.all(
      ["image-a", "image-b"].map((name) =>
        harness.createTerminal({ name, command: process.execPath, args: ["image-receiver.cjs"] }),
      ),
    );
    const payloads = [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
        "base64",
      ),
    ];
    try {
      await Promise.all([
        pasteImageInTerminal(page, harness, terminals[0]!.id, payloads[0]!),
        pasteImageInTerminal(secondPage, harness, terminals[1]!.id, payloads[1]!),
      ]);
      await page.reload();
      await harness.openTerminal(page, { terminalId: terminals[0]!.id });
      await expectCapturedImageOutput(harness, terminals[0]!.id, "IMAGE_STAGED");
      for (const [index, payload] of payloads.entries()) {
        // Release the fixture consumer only after the browser reconnects.
        harness.client.sendTerminalInput(terminals[index]!.id, { type: "input", data: "r" });
        const digest = createHash("sha256").update(payload).digest("hex");
        await expectCapturedImageOutput(harness, terminals[index]!.id, `IMAGE_READ:${digest}:600`);
      }
    } finally {
      await secondPage.close();
      await Promise.all(terminals.map((terminal) => harness.killTerminal(terminal.id)));
    }
  });
});
