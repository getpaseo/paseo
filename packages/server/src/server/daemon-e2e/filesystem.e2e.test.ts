import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "fs";
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
  test.each([
    {
      query: "implementation",
      expectedPaths: [
        ".cursor/plans/implementation-plan.md",
        ".codex/plans/implementation-plan.md",
        ".claude/plans/implementation-plan.md",
      ],
    },
    {
      query: ".cursor/plans/implementation",
      expectedPaths: [".cursor/plans/implementation-plan.md"],
    },
  ])(
    "workspace suggestions find hidden agent plans for '$query'",
    async ({ query, expectedPaths }) => {
      const cwd = tmpCwd();
      try {
        for (const directory of [".cursor", ".codex", ".claude", ".hidden"]) {
          mkdirSync(path.join(cwd, directory, "plans"), { recursive: true });
          writeFileSync(path.join(cwd, directory, "plans", "implementation-plan.md"), "plan\n");
        }

        const response = await ctx.client.getDirectorySuggestions({
          cwd,
          query,
          limit: 50,
          includeFiles: true,
          includeDirectories: true,
        });
        expect(response.error).toBeNull();
        expect(response.entries).toHaveLength(expectedPaths.length);
        expect(response.entries).toEqual(
          expect.arrayContaining(
            expectedPaths.map((entryPath) => ({ path: entryPath, kind: "file" })),
          ),
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  test.each(["..", "..."])("supports file operations on names starting with %s", async (prefix) => {
    const cwd = tmpCwd();
    const fileName = `${prefix}notes.txt`;
    const directoryName = `${prefix}drafts`;
    try {
      const createdFile = await ctx.client.createFileEntry({
        cwd,
        parentPath: ".",
        name: fileName,
        kind: "file",
      });
      expect(createdFile).toMatchObject({ path: fileName, success: true, error: null });
      writeFileSync(path.join(cwd, fileName), "notes payload\n");
      writeFileSync(path.join(cwd, ".notes.txt"), "dotfile control\n");
      writeFileSync(path.join(cwd, "notes.txt"), "ordinary control\n");

      const createdDirectory = await ctx.client.createFileEntry({
        cwd,
        parentPath: ".",
        name: directoryName,
        kind: "directory",
      });
      expect(createdDirectory).toMatchObject({ path: directoryName, success: true, error: null });
      const createdChild = await ctx.client.createFileEntry({
        cwd,
        parentPath: directoryName,
        name: "inside.txt",
        kind: "file",
      });
      expect(createdChild).toMatchObject({
        path: `${directoryName}/inside.txt`,
        success: true,
        error: null,
      });
      writeFileSync(path.join(cwd, directoryName, "inside.txt"), "nested payload\n");

      const directory = await ctx.client.listDirectory(cwd, ".");
      expect(
        Object.fromEntries(directory.entries.map((entry) => [entry.path, entry.kind])),
      ).toEqual({
        [directoryName]: "directory",
        [fileName]: "file",
        ".notes.txt": "file",
        "notes.txt": "file",
      });
      const children = await ctx.client.listDirectory(cwd, directoryName);
      expect(children.entries.map((entry) => entry.path)).toEqual([`${directoryName}/inside.txt`]);
      const file = await ctx.client.readFile(cwd, fileName);
      expect(file.path).toBe(fileName);
      expect(new TextDecoder().decode(file.bytes)).toBe("notes payload\n");
      const nestedFile = await ctx.client.readFile(cwd, `${directoryName}/inside.txt`);
      expect(nestedFile.path).toBe(`${directoryName}/inside.txt`);
      expect(new TextDecoder().decode(nestedFile.bytes)).toBe("nested payload\n");

      const dotfile = await ctx.client.readFile(cwd, ".notes.txt");
      expect(new TextDecoder().decode(dotfile.bytes)).toBe("dotfile control\n");
      const ordinaryFile = await ctx.client.readFile(cwd, "notes.txt");
      expect(new TextDecoder().decode(ordinaryFile.bytes)).toBe("ordinary control\n");

      const download = await ctx.client.requestDownloadToken(cwd, fileName);
      expect(download.error).toBeNull();
      expect(download.fileName).toBe(fileName);
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${download.token}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("notes payload\n");

      const renamedFileName = `${prefix}renamed.txt`;
      const renamed = await ctx.client.renameFileEntry({
        cwd,
        path: fileName,
        name: renamedFileName,
      });
      expect(renamed).toMatchObject({ renamedPath: renamedFileName, success: true, error: null });
      const renamedFile = await ctx.client.readFile(cwd, renamedFileName);
      expect(new TextDecoder().decode(renamedFile.bytes)).toBe("notes payload\n");

      const copiedDirectoryName = `${directoryName} copy`;
      const duplicated = await ctx.client.duplicateFileEntry({ cwd, path: directoryName });
      expect(duplicated).toMatchObject({
        duplicatedPath: copiedDirectoryName,
        success: true,
        error: null,
      });
      const copiedFile = await ctx.client.readFile(cwd, `${copiedDirectoryName}/inside.txt`);
      expect(new TextDecoder().decode(copiedFile.bytes)).toBe("nested payload\n");

      const deletedDirectory = await ctx.client.deleteFileEntry({ cwd, path: directoryName });
      expect(deletedDirectory).toMatchObject({ success: true, error: null });
      const deletedFile = await ctx.client.deleteFileEntry({ cwd, path: renamedFileName });
      expect(deletedFile).toMatchObject({ success: true, error: null });
      const remaining = await ctx.client.listDirectory(cwd, ".");
      expect(remaining.entries.map((entry) => entry.path).sort()).toEqual(
        [".notes.txt", "notes.txt", copiedDirectoryName].sort(),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects parent traversal and absolute paths to a sibling workspace", async () => {
    const directory = tmpCwd();
    const cwd = path.join(directory, "workspace");
    const outside = path.join(directory, "workspace-sibling");
    try {
      mkdirSync(cwd);
      mkdirSync(outside);
      writeFileSync(path.join(outside, "secret.txt"), "outside payload\n");
      for (const requestedPath of ["..", "../workspace-sibling", outside]) {
        await expect(ctx.client.listDirectory(cwd, requestedPath)).rejects.toThrow(
          "Access outside of workspace is not allowed",
        );
      }
      for (const requestedPath of [
        "../workspace-sibling/secret.txt",
        path.join(outside, "secret.txt"),
      ]) {
        await expect(ctx.client.readFile(cwd, requestedPath)).rejects.toThrow(
          "Access outside of workspace is not allowed",
        );
        const download = await ctx.client.requestDownloadToken(cwd, requestedPath);
        expect(download).toMatchObject({
          token: null,
          error: "Access outside of workspace is not allowed",
        });
        const deleted = await ctx.client.deleteFileEntry({ cwd, path: requestedPath });
        expect(deleted).toMatchObject({
          success: false,
          error: "Access outside of workspace is not allowed",
        });
      }
      expect(readdirSync(outside)).toEqual(["secret.txt"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts symlinks to double-dot names inside the workspace and rejects outside targets", async () => {
    const directory = tmpCwd();
    const cwd = path.join(directory, "workspace");
    const outside = path.join(directory, "workspace-sibling");
    try {
      mkdirSync(path.join(cwd, "..drafts"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(path.join(cwd, "..drafts", "notes.txt"), "inside payload\n");
      writeFileSync(path.join(outside, "secret.txt"), "outside payload\n");
      // Junctions also work on Windows without requiring symlink privileges.
      symlinkSync(path.join(cwd, "..drafts"), path.join(cwd, "inside-link"), "junction");
      symlinkSync(outside, path.join(cwd, "outside-link"), "junction");

      const listing = await ctx.client.listDirectory(cwd, ".");
      expect(listing.entries.map((entry) => entry.path).sort()).toEqual([
        "..drafts",
        "inside-link",
      ]);
      const file = await ctx.client.readFile(cwd, "inside-link/notes.txt");
      expect(file.path).toBe("inside-link/notes.txt");
      expect(new TextDecoder().decode(file.bytes)).toBe("inside payload\n");
      await expect(ctx.client.readFile(cwd, "outside-link/secret.txt")).rejects.toThrow(
        "Access outside of workspace is not allowed",
      );
      const download = await ctx.client.requestDownloadToken(cwd, "outside-link/secret.txt");
      expect(download).toMatchObject({
        token: null,
        error: "Access outside of workspace is not allowed",
      });
      expect(readdirSync(outside)).toEqual(["secret.txt"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
