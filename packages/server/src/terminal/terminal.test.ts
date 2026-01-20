import { describe, it, expect, afterEach } from "vitest";
import { createTerminal, type TerminalSession } from "./terminal.js";

// Extract text from a single row
function getRowText(state: ReturnType<TerminalSession["getState"]>, rowIndex: number): string {
  return state.grid[rowIndex].map((cell) => cell.char).join("").trimEnd();
}

// Extract all visible lines as array (trimmed, empty lines included)
function getLines(state: ReturnType<TerminalSession["getState"]>): string[] {
  return state.grid.map((row) => row.map((cell) => cell.char).join("").trimEnd());
}

// Wait for terminal state to match expected lines
async function waitForLines(
  session: TerminalSession,
  expectedLines: string[],
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = getLines(session.getState());
    let matches = true;
    for (let i = 0; i < expectedLines.length; i++) {
      if (lines[i] !== expectedLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const actual = getLines(session.getState()).slice(0, expectedLines.length);
  throw new Error(
    `Timeout waiting for expected lines.\nExpected:\n${JSON.stringify(expectedLines, null, 2)}\nActual:\n${JSON.stringify(actual, null, 2)}`
  );
}

describe("Terminal", () => {
  const sessions: TerminalSession[] = [];

  afterEach(async () => {
    for (const session of sessions) {
      session.kill();
    }
    sessions.length = 0;
  });

  function trackSession(session: TerminalSession): TerminalSession {
    sessions.push(session);
    return session;
  }

  describe("createTerminal", () => {
    it("creates a terminal session with an id, name, and cwd", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.name).toBe("Terminal");
      expect(session.cwd).toBe("/tmp");
    });

    it("uses custom name when provided", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          name: "Dev Server",
        })
      );

      expect(session.name).toBe("Dev Server");
    });

    it("uses default shell if not specified", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
        })
      );

      expect(session.id).toBeDefined();
    });

    it("uses default rows and cols", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      const state = session.getState();
      expect(state.rows).toBe(24);
      expect(state.cols).toBe(80);
    });

    it("respects custom rows and cols", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 40,
          cols: 120,
        })
      );

      const state = session.getState();
      expect(state.rows).toBe(40);
      expect(state.cols).toBe(120);
    });
  });

  describe("send input", () => {
    it("executes a simple echo command", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      // Wait for initial prompt, then send command
      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: "echo hello\r" });

      // After running "echo hello", terminal should show:
      // Line 0: "$ echo hello"
      // Line 1: "hello"
      // Line 2: "$"
      await waitForLines(session, ["$ echo hello", "hello", "$"]);

      const state = session.getState();
      expect(getRowText(state, 0)).toBe("$ echo hello");
      expect(getRowText(state, 1)).toBe("hello");
      expect(getRowText(state, 2)).toBe("$");
    });

    it("executes multiple commands sequentially", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: "echo first\r" });
      await waitForLines(session, ["$ echo first", "first", "$"]);

      session.send({ type: "input", data: "echo second\r" });
      await waitForLines(session, [
        "$ echo first",
        "first",
        "$ echo second",
        "second",
        "$",
      ]);

      const state = session.getState();
      expect(getRowText(state, 0)).toBe("$ echo first");
      expect(getRowText(state, 1)).toBe("first");
      expect(getRowText(state, 2)).toBe("$ echo second");
      expect(getRowText(state, 3)).toBe("second");
      expect(getRowText(state, 4)).toBe("$");
    });

    it("captures output from pwd in specified cwd", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      session.send({ type: "input", data: "pwd\r" });

      await waitForLines(session, ["$ pwd", "/tmp", "$"]);

      const state = session.getState();
      expect(getRowText(state, 0)).toBe("$ pwd");
      expect(getRowText(state, 1)).toBe("/tmp");
      expect(getRowText(state, 2)).toBe("$");
    });
  });

  describe("colors", () => {
    it("captures ANSI 16 color codes (mode 1)", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ ", TERM: "xterm-256color" },
        })
      );

      await waitForLines(session, ["$"]);

      // \033[31m = ANSI red (color 1)
      session.send({ type: "input", data: "printf '\\033[31mRED\\033[0m'\r" });

      await waitForLines(session, ["$ printf '\\033[31mRED\\033[0m'", "RED$"]);

      const state = session.getState();
      const outputRow = state.grid[1];

      expect(outputRow[0].char).toBe("R");
      expect(outputRow[0].fg).toBe(1); // ANSI red = 1
      expect(outputRow[0].fgMode).toBe(1); // Mode 1 = 16 ANSI colors

      // The "$" after RED should have default color
      expect(outputRow[3].char).toBe("$");
      expect(outputRow[3].fg).toBe(undefined);
      expect(outputRow[3].fgMode).toBe(undefined);
    });

    it("captures 256 color codes (mode 2)", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ ", TERM: "xterm-256color" },
        })
      );

      await waitForLines(session, ["$"]);

      // \033[38;5;208m = 256-color orange (color 208)
      session.send({ type: "input", data: "printf '\\033[38;5;208mORG\\033[0m'\r" });

      await waitForLines(session, ["$ printf '\\033[38;5;208mORG\\033[0m'", "ORG$"]);

      const state = session.getState();
      const outputRow = state.grid[1];

      // Check O cell
      expect(outputRow[0].char).toBe("O");
      expect(outputRow[0].fg).toBe(208); // 256-color index
      expect(outputRow[0].fgMode).toBe(2); // Mode 2 = 256 colors
    });

    it("captures true color RGB (mode 3)", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ ", TERM: "xterm-256color" },
        })
      );

      await waitForLines(session, ["$"]);

      // \033[38;2;255;128;64m = true color RGB(255, 128, 64)
      session.send({ type: "input", data: "printf '\\033[38;2;255;128;64mRGB\\033[0m'\r" });

      await waitForLines(session, ["$ printf '\\033[38;2;255;128;64mRGB\\033[0m'", "RGB$"]);

      const state = session.getState();
      const outputRow = state.grid[1];

      // Check R cell
      expect(outputRow[0].char).toBe("R");
      expect(outputRow[0].fgMode).toBe(3); // Mode 3 = true color

      // The color value should be packed RGB: (255 << 16) | (128 << 8) | 64
      const expectedPacked = (255 << 16) | (128 << 8) | 64;
      expect(outputRow[0].fg).toBe(expectedPacked);
    });

    it("captures background colors", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ ", TERM: "xterm-256color" },
        })
      );

      await waitForLines(session, ["$"]);

      // \033[41m = ANSI red background
      session.send({ type: "input", data: "printf '\\033[41mBG\\033[0m'\r" });

      await waitForLines(session, ["$ printf '\\033[41mBG\\033[0m'", "BG$"]);

      const state = session.getState();
      const outputRow = state.grid[1];

      expect(outputRow[0].char).toBe("B");
      expect(outputRow[0].bg).toBe(1); // ANSI red = 1
      expect(outputRow[0].bgMode).toBe(1); // Mode 1 = 16 ANSI colors
    });
  });

  describe("resize", () => {
    it("updates terminal dimensions on resize", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        })
      );

      session.send({ type: "resize", rows: 40, cols: 120 });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = session.getState();
      expect(state.rows).toBe(40);
      expect(state.cols).toBe(120);
    });

    it("grid reflects new dimensions after resize", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        })
      );

      session.send({ type: "resize", rows: 10, cols: 40 });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = session.getState();
      expect(state.grid.length).toBe(10);
      expect(state.grid[0].length).toBe(40);
    });
  });

  describe("subscribe", () => {
    it("receives full state on initial subscription", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].type).toBe("full");

      unsubscribe();
    });

    it("receives messages on updates", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      messages.length = 0;

      session.send({ type: "input", data: "echo test\r" });

      await waitForLines(session, ["$ echo test", "test", "$"]);

      expect(messages.length).toBeGreaterThan(0);

      unsubscribe();
    });

    it("unsubscribe stops receiving messages", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      const messages: Array<{ type: string }> = [];
      const unsubscribe = session.subscribe((msg) => {
        messages.push(msg);
      });

      unsubscribe();
      messages.length = 0;

      session.send({ type: "input", data: "echo after\r" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(messages.length).toBe(0);
    });
  });

  describe("getState", () => {
    it("returns current terminal state with grid", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 24,
          cols: 80,
        })
      );

      const state = session.getState();

      expect(state.rows).toBe(24);
      expect(state.cols).toBe(80);
      expect(state.grid).toBeDefined();
      expect(state.grid.length).toBe(24);
      expect(state.grid[0].length).toBe(80);
      expect(state.cursor).toBeDefined();
      expect(typeof state.cursor.row).toBe("number");
      expect(typeof state.cursor.col).toBe("number");
    });

    it("grid cells have char and color attributes", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      const state = session.getState();
      // First cell should be "$"
      expect(state.grid[0][0].char).toBe("$");
      expect(state.grid[0][0]).toHaveProperty("fg");
      expect(state.grid[0][0]).toHaveProperty("bg");
    });
  });

  describe("scrollback", () => {
    it("preserves scrollback buffer", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
          rows: 5,
          cols: 80,
        })
      );

      await waitForLines(session, ["$"]);

      // seq 1 20 produces 20 lines of output
      // With 5 rows, we expect lines to scroll into scrollback
      session.send({ type: "input", data: "seq 1 20\r" });

      // Wait for command to finish - final prompt appears after "20"
      // In a 5-row terminal, we'll see the last lines plus prompt
      // The visible area will show something like: 17, 18, 19, 20, $
      await waitForLines(session, ["17", "18", "19", "20", "$"]);

      const state = session.getState();

      // Scrollback should contain the earlier output
      expect(state.scrollback.length).toBeGreaterThan(0);

      const scrollbackText = state.scrollback
        .map((row) => row.map((cell) => cell.char).join("").trimEnd())
        .filter((line) => line.length > 0);

      // The scrollback should contain the command and early numbers
      expect(scrollbackText).toContain("$ seq 1 20");
      expect(scrollbackText).toContain("1");
      expect(scrollbackText).toContain("2");
      expect(scrollbackText).toContain("3");
    });
  });

  describe("kill", () => {
    it("terminates the shell process", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      await waitForLines(session, ["$"]);

      session.kill();

      // Should not throw when trying to get state after kill
      const state = session.getState();
      expect(state).toBeDefined();
    });

    it("send after kill is a no-op", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      session.kill();

      // Should not throw
      session.send({ type: "input", data: "echo test\r" });
    });
  });

  describe("mouse events", () => {
    it("accepts mouse events without throwing", async () => {
      const session = trackSession(
        await createTerminal({
          cwd: "/tmp",
          shell: "/bin/sh",
          env: { PS1: "$ " },
        })
      );

      // Should not throw
      session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "down" });
      session.send({ type: "mouse", row: 0, col: 0, button: 0, action: "up" });
    });
  });
});
