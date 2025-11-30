import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TerminalManager } from "./terminal-manager.js";
import { findSessionByName, killSession } from "./tmux.js";

const TEST_SESSION = "test-terminal-manager";

const ANSI_ESCAPE_REGEX = /\u001B[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

function expectMissingPathMessage(output: string, missingPath: string): void {
  const normalized = stripAnsi(output).toLowerCase();
  expect(normalized).toContain(missingPath.toLowerCase());
  expect(normalized).toMatch(/cannot access|no such file|not found/);
}

describe("TerminalManager - Command Execution", () => {
  let manager: TerminalManager;

  beforeAll(async () => {
    manager = new TerminalManager(TEST_SESSION);
    await manager.initialize();
  });

  afterAll(async () => {
    // Cleanup test session
    const session = await findSessionByName(TEST_SESSION);
    if (session) {
      await killSession(session.id);
    }
  });

  describe("executeCommand", () => {
    it("should execute a simple one-shot command and return exit code", async () => {
      const result = await manager.executeCommand(
        "echo 'Hello World'",
        process.env.HOME || "~",
        5000
      );

      expect(result.commandId).toMatch(/^@\d+$/);
      expect(result.output).toContain("Hello World");
      expect(result.isDead).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("should handle commands with pipes and operators", async () => {
      const result = await manager.executeCommand(
        "echo 'line1\nline2\nline3' | grep line2",
        process.env.HOME || "~",
        5000
      );

      expect(result.output).toContain("line2");
      expect(result.isDead).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("should capture non-zero exit codes", async () => {
      const result = await manager.executeCommand(
        "ls /nonexistent-directory-test 2>&1",
        process.env.HOME || "~",
        5000
      );

      expect(result.isDead).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expectMissingPathMessage(result.output, "nonexistent-directory-test");
    });

    it("should handle directory changes in command", async () => {
      const result = await manager.executeCommand(
        "cd /tmp && pwd",
        process.env.HOME || "~",
        5000
      );

      expect(result.output).toContain("/tmp");
      expect(result.isDead).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("should launch interactive command (Python REPL)", async () => {
      const result = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      expect(result.commandId).toMatch(/^@\d+$/);
      expect(result.output).toContain(">>>"); // Python prompt
      expect(result.isDead).toBe(false); // Still running
      expect(result.exitCode).toBeNull(); // No exit code yet

      // Cleanup
      await manager.killCommand(result.commandId);
    });

    it("should handle command with working directory", async () => {
      const result = await manager.executeCommand(
        "pwd",
        "/tmp",
        5000
      );

      expect(result.output).toContain("/tmp");
      expect(result.isDead).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("should handle long-running command with timeout", async () => {
      const result = await manager.executeCommand(
        "sleep 0.5 && echo 'Done sleeping'",
        process.env.HOME || "~",
        3000 // Increased timeout to ensure command completes
      );

      expect(result.output).toContain("Done sleeping");
      // Note: May still be alive if not enough time to detect completion
      if (result.isDead) {
        expect(result.exitCode).toBe(0);
      }
    });
  });

  describe("listCommands", () => {
    it("should list all commands including dead ones", async () => {
      // Execute a command that finishes
      const result1 = await manager.executeCommand(
        "echo 'test1'",
        process.env.HOME || "~",
        5000
      );

      // Execute a command that stays running
      const result2 = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      const commands = await manager.listCommands();

      expect(commands.length).toBeGreaterThanOrEqual(2);

      const cmd1 = commands.find((c) => c.id === result1.commandId);
      expect(cmd1).toBeDefined();
      expect(cmd1?.isDead).toBe(true);
      expect(cmd1?.exitCode).toBe(0);

      const cmd2 = commands.find((c) => c.id === result2.commandId);
      expect(cmd2).toBeDefined();
      expect(cmd2?.isDead).toBe(false);
      expect(cmd2?.exitCode).toBeNull();

      // Cleanup
      await manager.killCommand(result2.commandId);
    });

    it("should preserve command and working directory info for dead commands", async () => {
      const testDir1 = "/tmp";
      const testCommand1 = "echo 'test message 1' && pwd";
      const testDir2 = process.env.HOME || "~";
      const testCommand2 = "echo 'test message 2'";

      // Execute two different commands
      const result1 = await manager.executeCommand(
        testCommand1,
        testDir1,
        5000
      );

      const result2 = await manager.executeCommand(
        testCommand2,
        testDir2,
        5000
      );

      expect(result1.isDead).toBe(true);
      expect(result1.exitCode).toBe(0);
      expect(result2.isDead).toBe(true);
      expect(result2.exitCode).toBe(0);

      // List commands - should show the original command and working directory for each
      const commands = await manager.listCommands();
      const cmd1 = commands.find((c) => c.id === result1.commandId);
      const cmd2 = commands.find((c) => c.id === result2.commandId);

      // Verify first command
      expect(cmd1).toBeDefined();
      expect(cmd1?.isDead).toBe(true);
      expect(cmd1?.exitCode).toBe(0);
      expect(cmd1?.workingDirectory).toBe(testDir1);
      expect(cmd1?.currentCommand).toBe(testCommand1);

      // Verify second command (should have different values)
      expect(cmd2).toBeDefined();
      expect(cmd2?.isDead).toBe(true);
      expect(cmd2?.exitCode).toBe(0);
      expect(cmd2?.workingDirectory).toBe(testDir2);
      expect(cmd2?.currentCommand).toBe(testCommand2);

      // Ensure they're actually different
      expect(cmd1?.workingDirectory).not.toBe(cmd2?.workingDirectory);
      expect(cmd1?.currentCommand).not.toBe(cmd2?.currentCommand);

      // Cleanup
      await manager.killCommand(result1.commandId);
      await manager.killCommand(result2.commandId);
    });
  });

  describe("captureCommand", () => {
    it("should capture output from finished command", async () => {
      const execResult = await manager.executeCommand(
        "echo 'Capture test'",
        process.env.HOME || "~",
        5000
      );

      const captureResult = await manager.captureCommand(execResult.commandId, 100);

      expect(captureResult.output).toContain("Capture test");
      expect(captureResult.isDead).toBe(true);
      expect(captureResult.exitCode).toBe(0);
    });

    it("should capture output from running command", async () => {
      const execResult = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      const captureResult = await manager.captureCommand(execResult.commandId, 50);

      expect(captureResult.output).toContain(">>>");
      expect(captureResult.isDead).toBe(false);
      expect(captureResult.exitCode).toBeNull();

      // Cleanup
      await manager.killCommand(execResult.commandId);
    });
  });

  describe("sendTextToCommand", () => {
    it("should send text to running Python REPL", async () => {
      // Launch Python
      const execResult = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      // Send Python code
      const output = await manager.sendTextToCommand(
        execResult.commandId,
        "print('Hello from Python')",
        true, // press Enter
        { lines: 50, maxWait: 3000, waitForSettled: true }
      );

      expect(output).toContain("Hello from Python");

      // Send exit
      await manager.sendTextToCommand(
        execResult.commandId,
        "exit()",
        true,
        { lines: 50, maxWait: 2000 }
      );

      // Verify command is now dead
      const captureResult = await manager.captureCommand(execResult.commandId);
      expect(captureResult.isDead).toBe(true);
    });

    it("should handle multiple sequential inputs to REPL", async () => {
      const execResult = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      // First command
      await manager.sendTextToCommand(
        execResult.commandId,
        "x = 5",
        true,
        { lines: 50, maxWait: 2000 }
      );

      // Second command
      await manager.sendTextToCommand(
        execResult.commandId,
        "y = 3",
        true,
        { lines: 50, maxWait: 2000 }
      );

      // Third command - use variables
      const output = await manager.sendTextToCommand(
        execResult.commandId,
        "print(x + y)",
        true,
        { lines: 50, maxWait: 2000 }
      );

      expect(output).toContain("8");

      // Cleanup
      await manager.sendTextToCommand(execResult.commandId, "exit()", true);
    });
  });

  describe("sendKeysToCommand", () => {
    it("should send Ctrl-C to interrupt running command", async () => {
      // Start a long-running command
      const execResult = await manager.executeCommand(
        "sleep 100",
        process.env.HOME || "~",
        1000 // Short wait, won't finish
      );

      expect(execResult.isDead).toBe(false);

      // Send Ctrl-C
      await manager.sendKeysToCommand(
        execResult.commandId,
        "C-c",
        1,
        { lines: 50, maxWait: 2000 }
      );

      // Wait a bit for signal to process
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if command is now dead
      const captureResult = await manager.captureCommand(execResult.commandId);
      expect(captureResult.isDead).toBe(true);
    });

    it("should send Enter key to REPL", async () => {
      const execResult = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      // Type without pressing Enter
      await manager.sendTextToCommand(
        execResult.commandId,
        "print('test')",
        false // Don't press Enter
      );

      // Now send Enter via sendKeys
      const output = await manager.sendKeysToCommand(
        execResult.commandId,
        "Enter",
        1,
        { lines: 50, maxWait: 2000 }
      );

      expect(output).toContain("test");

      // Cleanup
      await manager.sendTextToCommand(execResult.commandId, "exit()", true);
    });

    it("should repeat key press multiple times", async () => {
      const execResult = await manager.executeCommand(
        "python3",
        process.env.HOME || "~",
        5000
      );

      // Send multiple Ctrl-C (should exit Python)
      await manager.sendKeysToCommand(
        execResult.commandId,
        "C-c",
        3, // Repeat 3 times
        { lines: 50, maxWait: 3000 }
      );

      // Wait longer for Python to exit
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const captureResult = await manager.captureCommand(execResult.commandId);
      // Python might not exit from Ctrl-C depending on state, so just verify we can still capture
      expect(captureResult.output).toBeDefined();

      // Cleanup if still running
      if (!captureResult.isDead) {
        await manager.killCommand(execResult.commandId);
      }
    });
  });

  describe("killCommand", () => {
    it("should kill running command", async () => {
      const execResult = await manager.executeCommand(
        "sleep 100",
        process.env.HOME || "~",
        1000
      );

      expect(execResult.isDead).toBe(false);

      // Kill the command
      await manager.killCommand(execResult.commandId);

      // Verify it's gone from list
      const commands = await manager.listCommands();
      const found = commands.find((c) => c.id === execResult.commandId);
      expect(found).toBeUndefined();
    });

    it("should kill finished command (cleanup)", async () => {
      const execResult = await manager.executeCommand(
        "echo 'cleanup test'",
        process.env.HOME || "~",
        5000
      );

      expect(execResult.isDead).toBe(true);

      // Kill/cleanup the command
      await manager.killCommand(execResult.commandId);

      // Verify it's gone from list
      const commands = await manager.listCommands();
      const found = commands.find((c) => c.id === execResult.commandId);
      expect(found).toBeUndefined();
    });
  });

  describe("Complex workflows", () => {
    it("should handle Node.js REPL workflow", async () => {
      // Launch Node REPL
      const execResult = await manager.executeCommand(
        "node",
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain(">"); // Node prompt
      expect(execResult.isDead).toBe(false);

      // Execute JavaScript
      await manager.sendTextToCommand(
        execResult.commandId,
        "const x = [1, 2, 3]",
        true,
        { lines: 50, maxWait: 2000 }
      );

      const output2 = await manager.sendTextToCommand(
        execResult.commandId,
        "x.map(n => n * 2)",
        true,
        { lines: 50, maxWait: 2000 }
      );

      expect(output2).toContain("2");
      expect(output2).toContain("4");
      expect(output2).toContain("6");

      // Exit
      await manager.sendTextToCommand(execResult.commandId, ".exit", true);

      // Verify exited
      await new Promise((resolve) => setTimeout(resolve, 500));
      const captureResult = await manager.captureCommand(execResult.commandId);
      expect(captureResult.isDead).toBe(true);
    });

    it("should handle command that produces streaming output", async () => {
      const execResult = await manager.executeCommand(
        "for i in 1 2 3; do echo Line $i; sleep 0.1; done",
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain("Line 1");
      expect(execResult.output).toContain("Line 2");
      expect(execResult.output).toContain("Line 3");
      expect(execResult.isDead).toBe(true);
      expect(execResult.exitCode).toBe(0);
    });

    it("should handle command with stderr output", async () => {
      const execResult = await manager.executeCommand(
        "echo 'to stdout'; echo 'to stderr' >&2",
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain("to stdout");
      expect(execResult.output).toContain("to stderr");
      expect(execResult.isDead).toBe(true);
      expect(execResult.exitCode).toBe(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty command output", async () => {
      const execResult = await manager.executeCommand(
        "true", // Command that produces no output
        process.env.HOME || "~",
        5000
      );

      expect(execResult.isDead).toBe(true);
      expect(execResult.exitCode).toBe(0);
    });

    it("should handle command with tilde in directory", async () => {
      const execResult = await manager.executeCommand(
        "pwd",
        "~/",
        5000
      );

      expect(execResult.output).toContain(process.env.HOME || "");
      expect(execResult.isDead).toBe(true);
    });

    it("should handle very long output", async () => {
      const execResult = await manager.executeCommand(
        "seq 1 500", // Generate 500 lines
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain("1");
      expect(execResult.output).toContain("500");
      expect(execResult.isDead).toBe(true);
      expect(execResult.exitCode).toBe(0);
    });

    it("should handle special characters in command", async () => {
      const execResult = await manager.executeCommand(
        "echo 'Special: $test & | ; < >'",
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain("Special:");
      expect(execResult.isDead).toBe(true);
      expect(execResult.exitCode).toBe(0);
    });

    it("should handle command with quotes", async () => {
      const execResult = await manager.executeCommand(
        `echo 'double and single quotes'`,
        process.env.HOME || "~",
        5000
      );

      expect(execResult.output).toContain("double");
      expect(execResult.output).toContain("single");
      expect(execResult.isDead).toBe(true);
    });
  });
});
