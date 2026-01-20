import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-terminal-e2e-"));
}

describe("daemon E2E terminal", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test(
    "lists terminals for a directory (auto-creates first)",
    async () => {
      const cwd = tmpCwd();

      const result = await ctx.client.listTerminals(cwd);

      expect(result.cwd).toBe(cwd);
      expect(result.terminals).toHaveLength(1);
      expect(result.terminals[0].name).toBe("Terminal 1");
      expect(result.terminals[0].id).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "creates additional terminal with custom name",
    async () => {
      const cwd = tmpCwd();

      // First call auto-creates Terminal 1
      await ctx.client.listTerminals(cwd);

      // Create a second terminal with custom name
      const result = await ctx.client.createTerminal(cwd, "Dev Server");

      expect(result.error).toBeNull();
      expect(result.terminal).toBeTruthy();
      expect(result.terminal!.name).toBe("Dev Server");
      expect(result.terminal!.cwd).toBe(cwd);

      // Verify list now shows two terminals
      const list = await ctx.client.listTerminals(cwd);
      expect(list.terminals).toHaveLength(2);

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "subscribes to terminal and receives state",
    async () => {
      const cwd = tmpCwd();

      // Get terminal (auto-creates)
      const list = await ctx.client.listTerminals(cwd);
      const terminalId = list.terminals[0].id;

      // Subscribe to terminal
      const subscribeResult = await ctx.client.subscribeTerminal(terminalId);

      expect(subscribeResult.error).toBeNull();
      expect(subscribeResult.terminalId).toBe(terminalId);
      expect(subscribeResult.state).toBeTruthy();
      expect(subscribeResult.state!.rows).toBeGreaterThan(0);
      expect(subscribeResult.state!.cols).toBeGreaterThan(0);
      expect(subscribeResult.state!.grid).toBeTruthy();
      expect(subscribeResult.state!.cursor).toBeTruthy();

      // Unsubscribe
      ctx.client.unsubscribeTerminal(terminalId);

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "sends input to terminal and receives output",
    async () => {
      const cwd = tmpCwd();

      // Get terminal
      const list = await ctx.client.listTerminals(cwd);
      const terminalId = list.terminals[0].id;

      // Subscribe to terminal
      await ctx.client.subscribeTerminal(terminalId);

      // Send input
      ctx.client.sendTerminalInput(terminalId, { type: "input", data: "echo hello\r" });

      // Wait for output containing "hello" - may need multiple updates
      let foundHello = false;
      const start = Date.now();
      const timeout = 10000;

      while (!foundHello && Date.now() - start < timeout) {
        try {
          const output = await ctx.client.waitForTerminalOutput(terminalId, 2000);
          expect(output.terminalId).toBe(terminalId);
          expect(output.state).toBeTruthy();

          // Extract text from grid
          const gridText = output.state.grid
            .map((row) => row.map((cell) => cell.char).join("").trimEnd())
            .filter((line) => line.length > 0)
            .join("\n");

          if (gridText.includes("hello")) {
            foundHello = true;
          }
        } catch {
          // Timeout waiting for output, try again
        }
      }

      expect(foundHello).toBe(true);

      // Cleanup
      ctx.client.unsubscribeTerminal(terminalId);
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "kills terminal",
    async () => {
      const cwd = tmpCwd();

      // Create terminal
      const createResult = await ctx.client.createTerminal(cwd, "To Kill");
      expect(createResult.terminal).toBeTruthy();
      const terminalId = createResult.terminal!.id;

      // Kill terminal
      const killResult = await ctx.client.killTerminal(terminalId);
      expect(killResult.success).toBe(true);
      expect(killResult.terminalId).toBe(terminalId);

      // Verify terminal is gone by trying to subscribe
      const subscribeResult = await ctx.client.subscribeTerminal(terminalId);
      expect(subscribeResult.error).toBe("Terminal not found");

      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );

  test(
    "returns error for relative path",
    async () => {
      // Try to list terminals with relative path
      const list = await ctx.client.listTerminals("relative/path");

      // Should return empty terminals (error case)
      expect(list.terminals).toHaveLength(0);
    },
    30000
  );

  test(
    "preserves color mode in terminal output (fgMode/bgMode)",
    async () => {
      const cwd = tmpCwd();

      // Get terminal
      const list = await ctx.client.listTerminals(cwd);
      const terminalId = list.terminals[0].id;

      // Subscribe to terminal
      await ctx.client.subscribeTerminal(terminalId);

      // Send printf with ANSI red color (mode 1)
      ctx.client.sendTerminalInput(terminalId, {
        type: "input",
        data: "printf '\\033[31mRED\\033[0m\\n'\r",
      });

      // Wait for output with colored text
      let foundColoredCell = false;
      const start = Date.now();
      const timeout = 10000;

      while (!foundColoredCell && Date.now() - start < timeout) {
        try {
          const output = await ctx.client.waitForTerminalOutput(terminalId, 2000);

          // Look for a cell with fgMode set
          for (const row of output.state.grid) {
            for (const cell of row) {
              if (cell.fgMode !== undefined && cell.fgMode > 0) {
                foundColoredCell = true;
                // Verify the mode is correct (1 = 16 ANSI colors)
                expect(cell.fgMode).toBe(1);
                expect(cell.fg).toBe(1); // ANSI red
                break;
              }
            }
            if (foundColoredCell) break;
          }
        } catch {
          // Timeout waiting for output, try again
        }
      }

      expect(foundColoredCell).toBe(true);

      ctx.client.unsubscribeTerminal(terminalId);
      rmSync(cwd, { recursive: true, force: true });
    },
    30000
  );
});
