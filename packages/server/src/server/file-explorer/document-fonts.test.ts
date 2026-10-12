import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { installDocumentFonts } from "./document-fonts.js";

test("installs verified fonts once, preserves unrelated user files, and fingerprints updates", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "paseo-font-source-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "paseo-font-target-"));
  const bytes = Buffer.from("test font bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    await writeFile(path.join(target, "personal-font.ttf"), "user font");
    await writeFile(path.join(source, "Demo-Regular.ttf"), bytes);
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify([{ file: "Demo-Regular.ttf", sha256 }]),
    );
    const first = await installDocumentFonts(source, target);
    expect(await installDocumentFonts(source, target)).toBe(first);
    expect(await readdir(target)).toHaveLength(2);
    expect(await readFile(path.join(target, "personal-font.ttf"), "utf8")).toBe("user font");
    await writeFile(path.join(source, "Demo-Regular.ttf"), "corrupted download");
    await expect(installDocumentFonts(source, target)).rejects.toThrow("checksum mismatch");
    expect(await readFile(path.join(target, `${sha256.slice(0, 12)}-Demo-Regular.ttf`))).toEqual(
      bytes,
    );
    const updated = createHash("sha256").update("corrupted download").digest("hex");
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify([{ file: "Demo-Regular.ttf", sha256: updated }]),
    );
    expect(await installDocumentFonts(source, target)).not.toBe(first);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("rejects font names that escape the package directory", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "paseo-font-source-"));
  try {
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify([{ file: "../other.ttf", sha256: "a".repeat(64) }]),
    );
    await expect(installDocumentFonts(source, path.join(source, "output"))).rejects.toThrow();
    expect(await readdir(source)).toEqual(["manifest.json"]);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
