import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDirectoryOpener, createExternalUrlOpener } from "./opener";

describe("desktop opener", () => {
  it("expands home paths and reports file manager failures", async () => {
    const opened: string[] = [];
    const open = createDirectoryOpener({
      openPath: async (value) => {
        opened.push(value);
        return "Finder could not open the folder";
      },
    });
    await expect(open("~/")).rejects.toThrow("Finder could not open the folder");
    expect(opened).toEqual([os.homedir()]);
  });

  it("rejects URLs, relative paths, and non-string directory inputs", async () => {
    const opened: string[] = [];
    const open = createDirectoryOpener({
      openPath: async (value) => {
        opened.push(value);
        return "";
      },
    });
    for (const candidate of ["file:///tmp", "https://example.com", "relative", null]) {
      await expect(open(candidate)).rejects.toThrow();
    }
    expect(opened).toEqual([]);
  });

  it("opens a local directory, leaving files and missing paths to Paseo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opener-"));
    const directory = path.join(root, "folder with spaces");
    const file = path.join(root, "file.txt");
    const opened: string[] = [];
    const open = createDirectoryOpener({
      openPath: async (value) => {
        opened.push(value);
        return "";
      },
    });
    try {
      await mkdir(directory);
      await writeFile(file, "content");
      expect(await open(directory)).toBe(true);
      expect(await open(file)).toBe(false);
      expect(await open(path.join(root, "missing"))).toBe(false);
      expect(opened).toEqual([directory]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes a canonical web URL to its external owner", async () => {
    const opened: string[] = [];
    const open = createExternalUrlOpener({
      open: async (url) => {
        opened.push(url);
      },
    });

    await open("https://example.com/docs#install");

    expect(opened).toEqual(["https://example.com/docs#install"]);
  });

  it("does not hand non-web or relative URLs to the external owner", async () => {
    const opened: string[] = [];
    const open = createExternalUrlOpener({
      open: async (url) => {
        opened.push(url);
      },
    });

    for (const input of [
      "file:///private/data",
      "javascript:alert(1)",
      "paseo://settings",
      "/docs",
      null,
    ]) {
      await expect(open(input)).rejects.toThrow("Only HTTP(S) URLs can open externally.");
    }

    expect(opened).toEqual([]);
  });
});
