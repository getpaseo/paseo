import { describe, expect, it } from "vitest";
import {
  buildImageMagickArgs,
  computeStampGeometry,
  resolveAppIconPath,
  resolveMonospaceFont,
} from "./stamped-icon";

describe("stamped-icon", () => {
  describe("resolveMonospaceFont", () => {
    it("selects Menlo-Bold on macOS when present", () => {
      const mockList = `
        Font: Helvetica-Bold
        Font: Menlo-Bold
        Font: Courier-New-Bold
      `;
      expect(resolveMonospaceFont(mockList)).toBe("Menlo-Bold");
    });

    it("selects Consolas-Bold on Windows when Menlo is absent", () => {
      const mockList = `
        Font: Arial
        Font: Consolas-Bold
        Font: Courier-New
      `;
      expect(resolveMonospaceFont(mockList)).toBe("Consolas-Bold");
    });

    it("selects DejaVu-Sans-Mono-Bold on Linux", () => {
      const mockList = `
        Font: DejaVu-Sans-Mono-Bold
        Font: FreeMono
      `;
      expect(resolveMonospaceFont(mockList)).toBe("DejaVu-Sans-Mono-Bold");
    });

    it("falls back to Courier when no preferred font matches", () => {
      const mockList = `
        Font: SomeUnknownFont
      `;
      expect(resolveMonospaceFont(mockList)).toBe("Courier");
    });
  });

  describe("computeStampGeometry", () => {
    it("computes lowercase geometry for short label", () => {
      const geo = computeStampGeometry(512, 512, "DEV");
      expect(geo.label).toBe("dev");
      expect(geo.pointsize).toBeGreaterThan(0);
      expect(geo.x1).toBeGreaterThan(0);
      expect(geo.x2).toBeLessThan(512);
      expect(geo.y1).toBeGreaterThan(0);
      expect(geo.y2).toBeLessThan(512);
    });

    it("scales geometry for large images", () => {
      const geo512 = computeStampGeometry(512, 512, "fix/desktop-stamp");
      const geo1024 = computeStampGeometry(1024, 1024, "fix/desktop-stamp");

      expect(geo1024.pointsize).toBeGreaterThan(geo512.pointsize);
      expect(geo1024.r).toBeGreaterThan(geo512.r);
    });
  });

  describe("buildImageMagickArgs", () => {
    it("builds valid composite args", () => {
      const geo = computeStampGeometry(512, 512, "test-branch");
      const args = buildImageMagickArgs("/in.png", "/out.png", geo, "Menlo-Bold", 512, 512);

      expect(args[0]).toBe("/in.png");
      expect(args[args.length - 1]).toBe("/out.png");
      expect(args).toContain("Menlo-Bold");
      expect(args).toContain("test-branch");
      expect(args).toContain("DstIn");
      expect(args).toContain("Over");
    });
  });

  describe("resolveAppIconPath", () => {
    it("returns base icon path immediately when packaged", async () => {
      const result = await resolveAppIconPath({
        isPackaged: true,
        baseIconPath: "/path/to/icon.png",
        devLabel: "feature/foo",
        cacheDir: "/cache",
      });
      expect(result).toBe("/path/to/icon.png");
    });

    it("returns base icon path when no dev label is provided", async () => {
      const result = await resolveAppIconPath({
        isPackaged: false,
        baseIconPath: "/path/to/icon.png",
        devLabel: null,
        cacheDir: "/cache",
      });
      expect(result).toBe("/path/to/icon.png");
    });

    it("returns null if baseIconPath is null", async () => {
      const result = await resolveAppIconPath({
        isPackaged: false,
        baseIconPath: null,
        devLabel: "dev",
        cacheDir: "/cache",
      });
      expect(result).toBeNull();
    });
  });
});
