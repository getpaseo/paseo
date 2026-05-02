import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

let ctx: DaemonTestContext;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
}, 60000);

describe("file explorer", () => {
  test("lists directory contents", async () => {
    const cwd = tmpCwd();

    // Create test files and directories
    writeFileSync(path.join(cwd, "test.txt"), "hello world\n");
    writeFileSync(path.join(cwd, "data.json"), '{"key": "value"}\n');
    mkdirSync(path.join(cwd, "subdir"));
    writeFileSync(path.join(cwd, "subdir", "nested.txt"), "nested content\n");

    // Create agent in the directory
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: CODEX_TEST_MODEL,
      thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
      cwd,
      title: "File Explorer Test",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.status).toBe("idle");

    // List directory contents
    const directory = await ctx.client.listDirectory(cwd, ".");

    // Verify listing returned without error
    expect(directory.entries).toBeTruthy();

    // Find expected entries
    const entries = directory.entries;
    const testTxt = entries.find((e) => e.name === "test.txt");
    const dataJson = entries.find((e) => e.name === "data.json");
    const subdir = entries.find((e) => e.name === "subdir");

    expect(testTxt).toBeTruthy();
    expect(testTxt!.kind).toBe("file");
    expect(testTxt!.size).toBeGreaterThan(0);

    expect(dataJson).toBeTruthy();
    expect(dataJson!.kind).toBe("file");

    expect(subdir).toBeTruthy();
    expect(subdir!.kind).toBe("directory");

    // Cleanup
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 60000); // 1 minute timeout

  test("reads file contents", async () => {
    const cwd = tmpCwd();
    const testContent = "This is test file content.\nLine 2.";
    const testFile = path.join(cwd, "readme.txt");
    writeFileSync(testFile, testContent);

    // Create agent in the directory
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: CODEX_TEST_MODEL,
      thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
      cwd,
      title: "File Read Test",
    });

    expect(agent.id).toBeTruthy();

    // Read file contents
    const result = await ctx.client.readFile(cwd, "readme.txt");

    // Verify file read
    // Server may return basename or full path
    expect(result.path).toContain("readme.txt");
    expect(result.kind).toBe("text");
    expect(new TextDecoder().decode(result.bytes)).toBe(testContent);
    expect(result.size).toBe(testContent.length);

    // Cleanup
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 60000); // 1 minute timeout

  test("returns error for non-existent path", async () => {
    const cwd = tmpCwd();

    // Create agent
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: CODEX_TEST_MODEL,
      thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
      cwd,
      title: "File Explorer Error Test",
    });

    expect(agent.id).toBeTruthy();

    // Try to list non-existent path
    await expect(ctx.client.listDirectory(cwd, "does-not-exist")).rejects.toThrow();

    // Cleanup
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 60000); // 1 minute timeout
});
