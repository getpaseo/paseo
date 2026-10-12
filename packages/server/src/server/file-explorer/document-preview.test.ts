import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDocumentPreview } from "./document-preview.js";
test.skipIf(process.env.PASEO_TEST_DOCUMENT_CONVERSION !== "1")(
  "converts a real DOCX locally and reuses the content-addressed PDF",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-word-preview-"));
    const cwd = fileURLToPath(new URL("./fixtures", import.meta.url));
    try {
      const original = await readFile(path.join(cwd, "preview.docx"));
      const first = await createDocumentPreview(home, cwd, "preview.docx");
      const pdf = await readFile(path.join(first.cwd, first.path));
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);
      for (const font of ["SourceHanSansSC", "SourceHanSerifSC", "LXGWWenKai"]) {
        expect(pdf.toString("latin1")).toContain(font);
      }
      expect(await readFile(path.join(cwd, "preview.docx"))).toEqual(original);
      expect(await createDocumentPreview(home, cwd, "preview.docx")).toEqual(first);
      await expect(createDocumentPreview(home, cwd, "../document-preview.ts")).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
