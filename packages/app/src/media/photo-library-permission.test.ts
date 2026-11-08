import { describe, expect, it } from "vitest";
import { needsPhotoLibraryPermission } from "./photo-library-permission";

describe("needsPhotoLibraryPermission", () => {
  it("asks for add-only permission on iOS", () => {
    expect(needsPhotoLibraryPermission("ios", "18.0")).toBe(true);
  });

  it("asks for write storage on Android 10, the last version that needs it", () => {
    expect(needsPhotoLibraryPermission("android", 29)).toBe(true);
  });

  it("saves through MediaStore without a permission on Android 11 and newer", () => {
    expect(needsPhotoLibraryPermission("android", 30)).toBe(false);
    expect(needsPhotoLibraryPermission("android", 36)).toBe(false);
  });
});
