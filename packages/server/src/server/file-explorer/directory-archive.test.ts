import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import JSZip from "jszip";
import { getDownloadableEntryInfo, streamDirectoryArchive } from "./service.js";

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

async function collect(root: string, relativePath: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamDirectoryArchive({ root, relativePath })) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("streamDirectoryArchive", () => {
  test("produces a zip containing the tree, with paths relative to the folder", async () => {
    const root = makeDir("archive-tree-");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "a.txt"), "alpha");
    writeFileSync(join(root, "src", "nested", "b.txt"), "beta");

    const zip = await JSZip.loadAsync(await collect(root, "src"));
    expect(Object.keys(zip.files).sort()).toEqual(["a.txt", "nested/b.txt"]);
    expect(await zip.file("a.txt")?.async("string")).toBe("alpha");
    expect(await zip.file("nested/b.txt")?.async("string")).toBe("beta");
  });

  test("preserves a non-ASCII entry name", async () => {
    const root = makeDir("archive-cjk-");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "設計ノート.md"), "x");

    const zip = await JSZip.loadAsync(await collect(root, "docs"));
    expect(Object.keys(zip.files)).toEqual(["設計ノート.md"]);
  });

  test("skips a symlink that points outside the workspace", async () => {
    const outside = makeDir("archive-outside-");
    writeFileSync(join(outside, "secret.txt"), "do not archive me");

    const root = makeDir("archive-symlink-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "real.txt"), "kept");
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "escape.txt"));
    symlinkSync(outside, join(root, "src", "escape-dir"));

    const zip = await JSZip.loadAsync(await collect(root, "src"));
    expect(Object.keys(zip.files)).toEqual(["real.txt"]);
  });

  test("refuses a path that escapes the workspace root", async () => {
    const root = makeDir("archive-escape-");
    await expect(collect(root, "../..")).rejects.toThrow(/outside of workspace/i);
  });

  test("refuses a file, which is not an archive source", async () => {
    const root = makeDir("archive-notdir-");
    writeFileSync(join(root, "a.txt"), "x");
    await expect(collect(root, "a.txt")).rejects.toThrow(/not a directory/i);
  });

  test("stops reading when the consumer stops early", async () => {
    const root = makeDir("archive-cancel-");
    mkdirSync(join(root, "big"));
    for (let i = 0; i < 40; i += 1) {
      writeFileSync(join(root, "big", `f${i}.bin`), Buffer.alloc(64 * 1024, i % 256));
    }

    const iterator = streamDirectoryArchive({ root, relativePath: "big" });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Mirrors a cancelled download: the session breaks out of the for-await.
    await expect(iterator.return(undefined)).resolves.toMatchObject({ done: true });
  });
});

describe("getDownloadableEntryInfo", () => {
  test("reports a directory as a zip whose size is not yet known", async () => {
    const root = makeDir("entry-info-dir-");
    mkdirSync(join(root, "src"));

    const info = await getDownloadableEntryInfo({ root, relativePath: "src" });
    expect(info).toMatchObject({
      kind: "directory",
      fileName: "src.zip",
      mimeType: "application/zip",
      size: null,
    });
  });

  test("reports a file with its real size", async () => {
    const root = makeDir("entry-info-file-");
    writeFileSync(join(root, "notes.txt"), "hello");

    const info = await getDownloadableEntryInfo({ root, relativePath: "notes.txt" });
    expect(info).toMatchObject({ kind: "file", fileName: "notes.txt", size: 5 });
  });

  test("stops walking the tree when cancelled before the first chunk", async () => {
    const root = makeDir("archive-cancel-walk-");
    mkdirSync(join(root, "big"));
    for (let i = 0; i < 30; i += 1) {
      mkdirSync(join(root, "big", `dir${i}`));
      writeFileSync(join(root, "big", `dir${i}`, "f.bin"), Buffer.alloc(1024, i % 256));
    }

    let statted = 0;
    const iterator = streamDirectoryArchive({
      root,
      relativePath: "big",
      // Cancel on the very first check, before any directory is read.
      isCancelled: () => {
        statted += 1;
        return true;
      },
    });

    // The walk bails, so the generator finishes without producing an archive.
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    // One check, not one per directory: it stopped at the top rather than walking through.
    expect(statted).toBeLessThanOrEqual(2);
  });

  test("produces the full archive when never cancelled", async () => {
    const root = makeDir("archive-nocancel-");
    mkdirSync(join(root, "site"));
    writeFileSync(join(root, "site", "a.txt"), "alpha");

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamDirectoryArchive({
      root,
      relativePath: "site",
      isCancelled: () => false,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});
