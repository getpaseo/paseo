import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __setRipgrepOverrideForTests,
  grepProject,
  listDir,
  readFile,
  resolveInsideCwd,
  writeFile,
} from "./local-fs-tools.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hubcode-fs-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveInsideCwd", () => {
  it("resolves relative paths inside cwd", () => {
    const r = resolveInsideCwd("/base", "src/index.ts");
    expect(r).toBe(path.resolve("/base/src/index.ts"));
  });

  it("rejects path escaping via ..", () => {
    expect(() => resolveInsideCwd("/base", "../etc/passwd")).toThrow(/escapes cwd/);
  });

  it("rejects absolute path outside cwd", () => {
    expect(() => resolveInsideCwd("/base", "/etc/passwd")).toThrow(/escapes cwd/);
  });

  it("accepts absolute path inside cwd", () => {
    const r = resolveInsideCwd("/base", "/base/src/file.ts");
    expect(r).toBe(path.resolve("/base/src/file.ts"));
  });
});

describe("readFile", () => {
  it("reads a utf-8 text file", async () => {
    await fs.writeFile(path.join(tmp, "hello.txt"), "hi there\n");
    const r = await readFile({ cwd: tmp, path: "hello.txt" });
    expect(r).toEqual({
      path: "hello.txt",
      content: "hi there\n",
      encoding: "utf-8",
      bytes: 9,
      truncated: false,
    });
  });

  it("returns base64 for binary content (NUL byte)", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await fs.writeFile(path.join(tmp, "bin"), binary);
    const r = await readFile({ cwd: tmp, path: "bin" });
    expect(r.encoding).toBe("base64");
    expect(Buffer.from(r.content, "base64").equals(binary)).toBe(true);
    expect(r.bytes).toBe(4);
  });

  it("truncates content when over maxBytes and flags it", async () => {
    await fs.writeFile(path.join(tmp, "big.txt"), "aaaaabbbbbccccc");
    const r = await readFile({ cwd: tmp, path: "big.txt", maxBytes: 5 });
    expect(r.content).toBe("aaaaa");
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(15);
  });

  it("rejects reading a directory", async () => {
    await fs.mkdir(path.join(tmp, "subdir"));
    await expect(readFile({ cwd: tmp, path: "subdir" })).rejects.toThrow(/Not a file/);
  });

  it("rejects paths escaping cwd", async () => {
    await expect(readFile({ cwd: tmp, path: "../outside" })).rejects.toThrow(/escapes cwd/);
  });
});

describe("writeFile", () => {
  it("writes utf-8 content to a new file", async () => {
    const r = await writeFile({ cwd: tmp, path: "new.txt", content: "hello" });
    expect(r).toEqual({ path: "new.txt", bytes: 5 });
    const onDisk = await fs.readFile(path.join(tmp, "new.txt"), "utf-8");
    expect(onDisk).toBe("hello");
  });

  it("creates parent dirs by default", async () => {
    await writeFile({
      cwd: tmp,
      path: "nested/deep/path/file.txt",
      content: "x",
    });
    const onDisk = await fs.readFile(path.join(tmp, "nested/deep/path/file.txt"), "utf-8");
    expect(onDisk).toBe("x");
  });

  it("does not create parent dirs when createDirs=false", async () => {
    await expect(
      writeFile({
        cwd: tmp,
        path: "nope/file.txt",
        content: "x",
        createDirs: false,
      }),
    ).rejects.toThrow();
  });

  it("writes base64 content as raw bytes", async () => {
    const bin = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await writeFile({
      cwd: tmp,
      path: "bin",
      content: bin.toString("base64"),
      encoding: "base64",
    });
    const onDisk = await fs.readFile(path.join(tmp, "bin"));
    expect(onDisk.equals(bin)).toBe(true);
  });

  it("overwrites existing files", async () => {
    await fs.writeFile(path.join(tmp, "x.txt"), "old");
    await writeFile({ cwd: tmp, path: "x.txt", content: "new" });
    expect(await fs.readFile(path.join(tmp, "x.txt"), "utf-8")).toBe("new");
  });

  it("rejects paths escaping cwd", async () => {
    await expect(writeFile({ cwd: tmp, path: "../evil", content: "x" })).rejects.toThrow(
      /escapes cwd/,
    );
  });
});

describe("listDir", () => {
  it("lists entries with type and size, dirs first", async () => {
    await fs.writeFile(path.join(tmp, "a.txt"), "hello");
    await fs.writeFile(path.join(tmp, "b.txt"), "hi");
    await fs.mkdir(path.join(tmp, "zsub"));
    const r = await listDir({ cwd: tmp });
    expect(r.path).toBe(".");
    expect(r.entries).toEqual([
      { name: "zsub", type: "dir", size: null },
      { name: "a.txt", type: "file", size: 5 },
      { name: "b.txt", type: "file", size: 2 },
    ]);
  });

  it("lists a nested subpath", async () => {
    await fs.mkdir(path.join(tmp, "src"));
    await fs.writeFile(path.join(tmp, "src/index.ts"), "x");
    const r = await listDir({ cwd: tmp, path: "src" });
    expect(r.path).toBe("src");
    expect(r.entries).toEqual([{ name: "index.ts", type: "file", size: 1 }]);
  });

  it("hides dotfiles when hideHidden is true", async () => {
    await fs.writeFile(path.join(tmp, ".env"), "SECRET");
    await fs.writeFile(path.join(tmp, "config.ts"), "x");
    const r = await listDir({ cwd: tmp, hideHidden: true });
    expect(r.entries.map((e) => e.name)).toEqual(["config.ts"]);
  });

  it("rejects a path that is a file", async () => {
    await fs.writeFile(path.join(tmp, "f.txt"), "x");
    await expect(listDir({ cwd: tmp, path: "f.txt" })).rejects.toThrow(/Not a directory/);
  });
});

describe("grepProject (JS backend)", () => {
  beforeEach(() => {
    // Force the JS fallback so tests don't depend on ripgrep being on
    // the developer's PATH.
    __setRipgrepOverrideForTests(false);
  });
  afterEach(() => {
    __setRipgrepOverrideForTests(null);
  });

  it("finds literal matches across files", async () => {
    await fs.writeFile(path.join(tmp, "a.ts"), "const FOO = 1;\nexport { FOO };\n");
    await fs.writeFile(path.join(tmp, "b.ts"), "import { FOO } from './a';\n");
    const r = await grepProject({ cwd: tmp, pattern: "FOO" });
    expect(r.backend).toBe("js");
    expect(r.matches).toHaveLength(3);
    expect(r.matches.map((m) => `${m.path}:${m.lineNumber}`).sort()).toEqual([
      "a.ts:1",
      "a.ts:2",
      "b.ts:1",
    ]);
  });

  it("is case-insensitive by default", async () => {
    await fs.writeFile(path.join(tmp, "x.md"), "Hello World\n");
    const r = await grepProject({ cwd: tmp, pattern: "hello" });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.line).toBe("Hello World");
  });

  it("is case-sensitive when caseSensitive is true", async () => {
    await fs.writeFile(path.join(tmp, "x.md"), "Hello World\n");
    const r = await grepProject({
      cwd: tmp,
      pattern: "hello",
      caseSensitive: true,
    });
    expect(r.matches).toHaveLength(0);
  });

  it("supports regex patterns by default", async () => {
    await fs.writeFile(path.join(tmp, "x.ts"), "const foo = 1;\nconst bar = 2;\n");
    const r = await grepProject({ cwd: tmp, pattern: "foo|bar" });
    expect(r.matches).toHaveLength(2);
  });

  it("treats pattern as literal when fixedString=true", async () => {
    await fs.writeFile(path.join(tmp, "x.ts"), "const foo = 1;\nconst bar = 2;\n");
    const r = await grepProject({
      cwd: tmp,
      pattern: "foo|bar",
      fixedString: true,
    });
    // No literal "foo|bar" in the file.
    expect(r.matches).toHaveLength(0);
  });

  it("filters by glob", async () => {
    await fs.writeFile(path.join(tmp, "a.ts"), "needle\n");
    await fs.writeFile(path.join(tmp, "b.md"), "needle\n");
    const r = await grepProject({ cwd: tmp, pattern: "needle", glob: "*.ts" });
    expect(r.matches.map((m) => m.path)).toEqual(["a.ts"]);
  });

  it("skips node_modules and .git", async () => {
    await fs.mkdir(path.join(tmp, "node_modules/foo"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".git/objects"), { recursive: true });
    await fs.writeFile(path.join(tmp, "node_modules/foo/index.js"), "needle\n");
    await fs.writeFile(path.join(tmp, ".git/objects/pack"), "needle\n");
    await fs.writeFile(path.join(tmp, "src.ts"), "needle\n");
    const r = await grepProject({ cwd: tmp, pattern: "needle" });
    expect(r.matches.map((m) => m.path)).toEqual(["src.ts"]);
  });

  it("truncates at maxResults and flags truncated", async () => {
    await fs.writeFile(path.join(tmp, "x.ts"), "x\nx\nx\nx\nx\n");
    const r = await grepProject({ cwd: tmp, pattern: "x", maxResults: 3 });
    expect(r.matches).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
});
