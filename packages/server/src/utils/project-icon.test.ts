import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findProjectIcon, getProjectIcon, ICON_PATTERNS, PRIORITY_DIRS, IGNORED_DIRS } from "./project-icon.js";

function createTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "project-icon-test-")));
}

describe("findProjectIcon", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("ICON_PATTERNS", () => {
    it("includes common favicon patterns", () => {
      expect(ICON_PATTERNS).toContain("favicon.ico");
      expect(ICON_PATTERNS).toContain("favicon.png");
      expect(ICON_PATTERNS).toContain("favicon.svg");
    });

    it("includes app icon patterns", () => {
      expect(ICON_PATTERNS).toContain("icon.png");
      expect(ICON_PATTERNS).toContain("icon.svg");
      expect(ICON_PATTERNS).toContain("app-icon.png");
    });

    it("includes logo patterns", () => {
      expect(ICON_PATTERNS).toContain("logo.png");
      expect(ICON_PATTERNS).toContain("logo.svg");
    });
  });

  describe("PRIORITY_DIRS", () => {
    it("includes common asset directories", () => {
      expect(PRIORITY_DIRS).toContain("public");
      expect(PRIORITY_DIRS).toContain("static");
      expect(PRIORITY_DIRS).toContain("assets");
    });
  });

  describe("IGNORED_DIRS", () => {
    it("includes common ignored directories", () => {
      expect(IGNORED_DIRS).toContain(".git");
      expect(IGNORED_DIRS).toContain("node_modules");
      expect(IGNORED_DIRS).toContain("dist");
      expect(IGNORED_DIRS).toContain("build");
    });
  });

  it("returns null when no icon is found", async () => {
    const result = await findProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("finds favicon.ico in root directory", async () => {
    writeFileSync(join(tempDir, "favicon.ico"), "icon content");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "favicon.ico"));
  });

  it("finds favicon.png in root directory", async () => {
    writeFileSync(join(tempDir, "favicon.png"), "icon content");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "favicon.png"));
  });

  it("finds icon in public directory (priority dir)", async () => {
    mkdirSync(join(tempDir, "public"));
    writeFileSync(join(tempDir, "public", "favicon.ico"), "icon content");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "public", "favicon.ico"));
  });

  it("finds icon in static directory (priority dir)", async () => {
    mkdirSync(join(tempDir, "static"));
    writeFileSync(join(tempDir, "static", "favicon.svg"), "icon content");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "static", "favicon.svg"));
  });

  it("finds icon in assets directory (priority dir)", async () => {
    mkdirSync(join(tempDir, "assets"));
    writeFileSync(join(tempDir, "assets", "logo.png"), "icon content");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "assets", "logo.png"));
  });

  it("prioritizes favicon over logo", async () => {
    writeFileSync(join(tempDir, "favicon.ico"), "favicon");
    writeFileSync(join(tempDir, "logo.png"), "logo");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "favicon.ico"));
  });

  it("prioritizes priority dirs over root", async () => {
    writeFileSync(join(tempDir, "logo.png"), "root logo");
    mkdirSync(join(tempDir, "public"));
    writeFileSync(join(tempDir, "public", "favicon.ico"), "public favicon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "public", "favicon.ico"));
  });

  it("ignores files in .git directory", async () => {
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, ".git", "favicon.ico"), "git icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("ignores files in node_modules directory", async () => {
    mkdirSync(join(tempDir, "node_modules"));
    writeFileSync(join(tempDir, "node_modules", "favicon.ico"), "node icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("ignores files in dist directory", async () => {
    mkdirSync(join(tempDir, "dist"));
    writeFileSync(join(tempDir, "dist", "favicon.ico"), "dist icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("finds icon in nested priority directory", async () => {
    mkdirSync(join(tempDir, "public", "images"), { recursive: true });
    writeFileSync(join(tempDir, "public", "images", "favicon.png"), "nested icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "public", "images", "favicon.png"));
  });

  it("finds apple-touch-icon.png", async () => {
    writeFileSync(join(tempDir, "apple-touch-icon.png"), "apple icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "apple-touch-icon.png"));
  });

  it("finds icon-*.png patterns", async () => {
    writeFileSync(join(tempDir, "icon-192.png"), "192 icon");

    const result = await findProjectIcon(tempDir);
    expect(result).toBe(join(tempDir, "icon-192.png"));
  });

  it("handles non-existent directory gracefully", async () => {
    const result = await findProjectIcon(join(tempDir, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns the first match when multiple icons exist in same location", async () => {
    writeFileSync(join(tempDir, "favicon.ico"), "ico");
    writeFileSync(join(tempDir, "favicon.png"), "png");
    writeFileSync(join(tempDir, "favicon.svg"), "svg");

    const result = await findProjectIcon(tempDir);
    // Should return the first one based on pattern order (favicon.ico comes first)
    expect(result).toBe(join(tempDir, "favicon.ico"));
  });
});

describe("getProjectIcon", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Valid 1x1 PNG (square)
  const squarePng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, // width: 1
    0x00, 0x00, 0x00, 0x01, // height: 1
    0x08, 0x02, // bit depth, color type
    0x00, 0x00, 0x00, // compression, filter, interlace
    0x90, 0x77, 0x53, 0xde, // CRC
    0x00, 0x00, 0x00, 0x0c, // IDAT chunk length
    0x49, 0x44, 0x41, 0x54, // IDAT
    0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff, 0x00, 0x05, 0xfe, 0x02, 0xfe, // data
    0xa3, 0x6c, 0x47, 0x9f, // CRC
    0x00, 0x00, 0x00, 0x00, // IEND chunk length
    0x49, 0x45, 0x4e, 0x44, // IEND
    0xae, 0x42, 0x60, 0x82, // CRC
  ]);

  // Valid 2x1 PNG (non-square)
  const nonSquarePng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x02, // width: 2
    0x00, 0x00, 0x00, 0x01, // height: 1
    0x08, 0x02, // bit depth, color type
    0x00, 0x00, 0x00, // compression, filter, interlace
    0x00, 0x00, 0x00, 0x00, // CRC (not validated)
  ]);

  it("returns icon data for square PNG", async () => {
    writeFileSync(join(tempDir, "favicon.png"), squarePng);

    const result = await getProjectIcon(tempDir);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.data).toBe(squarePng.toString("base64"));
  });

  it("returns null for non-square PNG", async () => {
    writeFileSync(join(tempDir, "favicon.png"), nonSquarePng);

    const result = await getProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("returns icon data for ICO files (assumed square)", async () => {
    writeFileSync(join(tempDir, "favicon.ico"), "ico content");

    const result = await getProjectIcon(tempDir);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("image/x-icon");
  });

  it("returns icon data for SVG files (assumed square)", async () => {
    writeFileSync(join(tempDir, "favicon.svg"), "<svg></svg>");

    const result = await getProjectIcon(tempDir);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("image/svg+xml");
  });

  it("returns null for files over 32KB", async () => {
    const largeContent = Buffer.alloc(33 * 1024, 0);
    writeFileSync(join(tempDir, "favicon.ico"), largeContent);

    const result = await getProjectIcon(tempDir);
    expect(result).toBeNull();
  });

  it("returns null when no icon is found", async () => {
    const result = await getProjectIcon(tempDir);
    expect(result).toBeNull();
  });
});
