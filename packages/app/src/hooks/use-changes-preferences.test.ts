import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn<(_: string) => Promise<string | null>>(),
  setItem: vi.fn<(_: string, __: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

describe("use-changes-preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.getItem.mockReset();
    asyncStorageMock.setItem.mockReset();
  });

  it("defaults to unified layout with visible whitespace", async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-changes-preferences");
    const result = await mod.loadChangesPreferencesFromStorage();

    expect(result).toEqual(mod.DEFAULT_CHANGES_PREFERENCES);
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      "@paseo:changes-preferences",
      JSON.stringify(mod.DEFAULT_CHANGES_PREFERENCES),
    );
  });

  it("migrates the legacy wrap-lines toggle into the new preferences object", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "diff-wrap-lines") {
        return "true";
      }
      return null;
    });
    asyncStorageMock.setItem.mockResolvedValue();

    const mod = await import("./use-changes-preferences");
    const result = await mod.loadChangesPreferencesFromStorage();

    expect(result).toEqual({
      layout: "unified",
      wrapLines: true,
      hideWhitespace: false,
    });
  });

  it("loads persisted layout and whitespace preferences", async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === "@paseo:changes-preferences") {
        return JSON.stringify({
          layout: "split",
          hideWhitespace: true,
          wrapLines: false,
        });
      }
      return null;
    });

    const mod = await import("./use-changes-preferences");
    const result = await mod.loadChangesPreferencesFromStorage();

    expect(result).toEqual({
      layout: "split",
      hideWhitespace: true,
      wrapLines: false,
    });
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
  });
});
