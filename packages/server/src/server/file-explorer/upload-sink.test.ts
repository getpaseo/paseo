import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createUploadSink } from "./service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("createUploadSink path safety", () => {
  test("refuses a relative path that climbs out of the workspace", async () => {
    const root = makeDir("upload-escape-");
    await expect(
      createUploadSink({ root, relativePath: "../escaped.txt", overwrite: "fail" }),
    ).rejects.toThrow(/outside of workspace/i);
  });

  test("refuses an absolute path", async () => {
    const root = makeDir("upload-abs-");
    await expect(
      createUploadSink({ root, relativePath: "/etc/passwd", overwrite: "replace" }),
    ).rejects.toThrow(/outside of workspace/i);
  });

  test("refuses a symlinked parent directory pointing outside the workspace", async () => {
    const outside = makeDir("upload-outside-");
    const root = makeDir("upload-symlink-parent-");
    symlinkSync(outside, join(root, "escape"));

    await expect(
      createUploadSink({ root, relativePath: "escape/planted.txt", overwrite: "replace" }),
    ).rejects.toThrow(/outside of workspace/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses the workspace root itself as a target", async () => {
    const root = makeDir("upload-noname-");
    // "." resolves the parent above the root, so containment refuses it before
    // the file-name guard is reached.
    await expect(createUploadSink({ root, relativePath: ".", overwrite: "fail" })).rejects.toThrow(
      /outside of workspace/i,
    );
  });
});

describe("createUploadSink overwrite modes", () => {
  test("fail refuses when the name is taken and leaves the original intact", async () => {
    const root = makeDir("upload-fail-");
    writeFileSync(join(root, "a.txt"), "original");

    await expect(
      createUploadSink({ root, relativePath: "a.txt", overwrite: "fail" }),
    ).rejects.toThrow(/already exists/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original");
  });

  test("replace swaps the contents", async () => {
    const root = makeDir("upload-replace-");
    writeFileSync(join(root, "a.txt"), "original");

    const sink = await createUploadSink({ root, relativePath: "a.txt", overwrite: "replace" });
    await sink.write(bytes("replaced"));
    const result = await sink.commit();

    expect(result.path).toBe("a.txt");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("replaced");
  });

  test("rename picks the next free name instead of clobbering", async () => {
    const root = makeDir("upload-rename-");
    writeFileSync(join(root, "a.txt"), "original");

    const sink = await createUploadSink({ root, relativePath: "a.txt", overwrite: "rename" });
    await sink.write(bytes("second"));
    const result = await sink.commit();

    expect(result.path).toBe("a (1).txt");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "a (1).txt"), "utf8")).toBe("second");
  });

  test("refuses a symlinked target that points outside the workspace", async () => {
    const outside = makeDir("upload-linktarget-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "untouched");

    const root = makeDir("upload-linkswap-");
    symlinkSync(secret, join(root, "link.txt"));

    await expect(
      createUploadSink({ root, relativePath: "link.txt", overwrite: "replace" }),
    ).rejects.toThrow(/outside of workspace/i);
    expect(readFileSync(secret, "utf8")).toBe("untouched");
  });

  test("replaces a symlink that stays inside the workspace by swapping the link", async () => {
    const root = makeDir("upload-innerlink-");
    writeFileSync(join(root, "real.txt"), "original");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

    const sink = await createUploadSink({ root, relativePath: "link.txt", overwrite: "replace" });
    await sink.write(bytes("new content"));
    await sink.commit();

    // rename() does not follow symlinks, so the link is replaced, not written through.
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "link.txt"), "utf8")).toBe("new content");
  });
});

describe("createUploadSink lifecycle", () => {
  test("streams multiple chunks in order", async () => {
    const root = makeDir("upload-chunks-");
    const sink = await createUploadSink({ root, relativePath: "out.bin", overwrite: "fail" });
    await sink.write(bytes("one "));
    await sink.write(bytes("two "));
    await sink.write(bytes("three"));
    const result = await sink.commit();

    expect(result.size).toBe(13);
    expect(readFileSync(join(root, "out.bin"), "utf8")).toBe("one two three");
  });

  test("preserves a non-ASCII file name byte-for-byte", async () => {
    const root = makeDir("upload-cjk-");
    const fileName = "設計ノート 🗂.md";
    const sink = await createUploadSink({ root, relativePath: fileName, overwrite: "fail" });
    await sink.write(bytes("x"));
    const result = await sink.commit();

    expect(result.path).toBe(fileName);
    expect(readdirSync(root)).toContain(fileName);
  });

  test("abort leaves no file and no temp file behind", async () => {
    const root = makeDir("upload-abort-");
    const sink = await createUploadSink({ root, relativePath: "partial.txt", overwrite: "fail" });
    await sink.write(bytes("half"));
    await sink.abort();

    expect(readdirSync(root)).toEqual([]);
  });

  test("nothing is visible at the destination until commit", async () => {
    const root = makeDir("upload-atomic-");
    const sink = await createUploadSink({ root, relativePath: "late.txt", overwrite: "fail" });
    await sink.write(bytes("in flight"));

    expect(readdirSync(root).some((name) => name === "late.txt")).toBe(false);

    await sink.commit();
    expect(readFileSync(join(root, "late.txt"), "utf8")).toBe("in flight");
  });

  test("writing into a subdirectory of the workspace is allowed", async () => {
    const root = makeDir("upload-subdir-");
    mkdirSync(join(root, "assets"));

    const sink = await createUploadSink({
      root,
      relativePath: "assets/logo.png",
      overwrite: "fail",
    });
    await sink.write(bytes("png"));
    const result = await sink.commit();

    expect(result.path).toBe("assets/logo.png");
  });

  // The sink resolves the target through realpath, so a root that is not already
  // canonical — a symlink here, an 8.3 short name on Windows — made the reported
  // path relative to the wrong directory and climb out of the workspace.
  test("reports a path relative to a root that is not canonical", async () => {
    const real = makeDir("upload-real-");
    const link = join(mkdtempSync(join(tmpdir(), "upload-link-")), "root");
    tempDirs.push(link);
    symlinkSync(real, link, "dir");

    const sink = await createUploadSink({
      root: link,
      relativePath: "notes.txt",
      overwrite: "fail",
    });
    await sink.write(bytes("via a symlinked root"));
    const result = await sink.commit();

    expect(result.path).toBe("notes.txt");
    expect(readFileSync(join(real, "notes.txt"), "utf8")).toBe("via a symlinked root");
  });

  test("creates a folder tree under a root that is not canonical", async () => {
    const real = makeDir("upload-tree-real-");
    const link = join(mkdtempSync(join(tmpdir(), "upload-tree-link-")), "root");
    tempDirs.push(link);
    symlinkSync(real, link, "dir");

    const sink = await createUploadSink({
      root: link,
      relativePath: "src/components/button.tsx",
      overwrite: "fail",
      createMissingDirectories: true,
    });
    await sink.write(bytes("export const Button = () => null;"));
    const result = await sink.commit();

    expect(result.path).toBe("src/components/button.tsx");
    expect(readFileSync(join(real, "src/components/button.tsx"), "utf8")).toBe(
      "export const Button = () => null;",
    );
  });
});

describe("createUploadSink folder trees", () => {
  test("creates missing intermediate directories when asked", async () => {
    const root = makeDir("upload-mkdir-");
    const sink = await createUploadSink({
      root,
      relativePath: "site/assets/img/logo.png",
      overwrite: "fail",
      createMissingDirectories: true,
    });
    await sink.write(bytes("png"));
    const result = await sink.commit();

    expect(result.path).toBe("site/assets/img/logo.png");
    expect(readFileSync(join(root, "site", "assets", "img", "logo.png"), "utf8")).toBe("png");
  });

  test("refuses to create directories by default", async () => {
    const root = makeDir("upload-nomkdir-");
    await expect(
      createUploadSink({ root, relativePath: "missing/logo.png", overwrite: "fail" }),
    ).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  test("refuses to traverse a symlinked segment while creating directories", async () => {
    const outside = makeDir("upload-tree-outside-");
    const root = makeDir("upload-tree-symlink-");
    symlinkSync(outside, join(root, "escape"));

    await expect(
      createUploadSink({
        root,
        relativePath: "escape/deep/planted.txt",
        overwrite: "replace",
        createMissingDirectories: true,
      }),
    ).rejects.toThrow(/outside of workspace/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses a path that passes through an existing file", async () => {
    const root = makeDir("upload-throughfile-");
    writeFileSync(join(root, "notafolder"), "x");

    await expect(
      createUploadSink({
        root,
        relativePath: "notafolder/child.txt",
        overwrite: "fail",
        createMissingDirectories: true,
      }),
    ).rejects.toThrow(/passes through a file/i);
  });

  test("reuses directories that already exist", async () => {
    const root = makeDir("upload-reuse-");
    mkdirSync(join(root, "site", "assets"), { recursive: true });
    writeFileSync(join(root, "site", "assets", "keep.txt"), "keep");

    const sink = await createUploadSink({
      root,
      relativePath: "site/assets/new.txt",
      overwrite: "fail",
      createMissingDirectories: true,
    });
    await sink.write(bytes("new"));
    await sink.commit();

    expect(readFileSync(join(root, "site", "assets", "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(root, "site", "assets", "new.txt"), "utf8")).toBe("new");
  });
});

describe("createUploadSink commit atomicity", () => {
  test("a file appearing mid-upload is not destroyed under fail", async () => {
    const root = makeDir("upload-toctou-fail-");
    const sink = await createUploadSink({ root, relativePath: "a.txt", overwrite: "fail" });
    await sink.write(bytes("uploaded"));

    // An agent writes the same path while the transfer is still in flight; the pre-flight
    // existence check has already passed.
    writeFileSync(join(root, "a.txt"), "written by someone else");

    await expect(sink.commit()).rejects.toThrow();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("written by someone else");
    // No temp file survives the refusal.
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  test("a file appearing mid-upload is not destroyed under rename", async () => {
    const root = makeDir("upload-toctou-rename-");
    const sink = await createUploadSink({ root, relativePath: "a.txt", overwrite: "rename" });
    await sink.write(bytes("uploaded"));

    writeFileSync(join(root, "a.txt"), "written by someone else");

    await expect(sink.commit()).rejects.toThrow();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("written by someone else");
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  test("replace still overwrites, which is what it promises", async () => {
    const root = makeDir("upload-toctou-replace-");
    const sink = await createUploadSink({ root, relativePath: "a.txt", overwrite: "replace" });
    await sink.write(bytes("uploaded"));

    writeFileSync(join(root, "a.txt"), "written by someone else");

    await expect(sink.commit()).resolves.toMatchObject({ path: "a.txt" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("uploaded");
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });
});
