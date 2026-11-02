import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHeadlessTerminal } from "./headless-terminal.js";

const EMOJI_ROW = "A😀👍❤️👋🏽🇰🇷👨‍👩‍👧B";
// A, six two-column emoji clusters, B.
const EMOJI_ROW_END_COL = 1 + 6 * 2 + 1;

async function cursorColAfter(text: string): Promise<number> {
  const terminal = createHeadlessTerminal({ rows: 2, cols: 40 });
  try {
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    return terminal.buffer.active.cursorX;
  } finally {
    terminal.dispose();
  }
}

describe("createHeadlessTerminal", () => {
  it("gives each emoji cluster one two-column cell", async () => {
    expect(await cursorColAfter(EMOJI_ROW)).toBe(EMOJI_ROW_END_COL);
  });

  it("keeps ASCII and CJK widths", async () => {
    expect(await cursorColAfter("ABC")).toBe(3);
    expect(await cursorColAfter("中文")).toBe(4);
  });

  // The width table is decoded into a Node Buffer when the module loads. A
  // Buffer carved out of Node's shared pool starts at a non-zero byteOffset,
  // and an addon that reads the table header from offset 0 gets wrong widths
  // or fails to load. Whether the pool offset is zero depends on earlier
  // allocations, so the test forces a non-zero offset in a fresh process
  // before the module loads. Zero bytes in front of the table make the
  // misread header deterministic.
  it("decodes widths correctly when Node's buffer pool offset is non-zero", () => {
    const moduleUrl = new URL("./headless-terminal.ts", import.meta.url).href;
    const script = `
      Buffer.poolSize = 8 * 1024 * 1024;
      const occupied = Buffer.from(new Uint8Array(3 * 1024 * 1024));
      if (occupied.byteOffset !== 0 || occupied.buffer.byteLength !== Buffer.poolSize) {
        throw new Error("expected a fresh shared pool");
      }
      const { createHeadlessTerminal } = await import(${JSON.stringify(moduleUrl)});
      const terminal = createHeadlessTerminal({ rows: 2, cols: 40 });
      await new Promise((resolve) => terminal.write(${JSON.stringify(EMOJI_ROW)}, resolve));
      process.stdout.write(String(terminal.buffer.active.cursorX));
      terminal.dispose();
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(String(EMOJI_ROW_END_COL));
  });
});
