import { describe, expect, it } from "vitest";
import { resolveDesktopWindowChromeMode, windowChromeModeArgument } from "./chrome";

describe("desktop window chrome", () => {
  it("maps each operating system to its shipped chrome", () => {
    expect(
      resolveDesktopWindowChromeMode({ platform: "darwin", override: undefined, isPackaged: true }),
    ).toBe("native-mac");
    expect(
      resolveDesktopWindowChromeMode({ platform: "win32", override: undefined, isPackaged: true }),
    ).toBe("custom-windows");
    expect(
      resolveDesktopWindowChromeMode({ platform: "linux", override: undefined, isPackaged: true }),
    ).toBe("custom-linux");
  });

  it("allows development builds to preview custom controls on macOS", () => {
    expect(
      resolveDesktopWindowChromeMode({
        platform: "darwin",
        override: "windows",
        isPackaged: false,
      }),
    ).toBe("custom-windows");
    expect(
      resolveDesktopWindowChromeMode({ platform: "darwin", override: "linux", isPackaged: false }),
    ).toBe("custom-linux");
  });

  it("rejects invalid and packaged overrides", () => {
    expect(() =>
      resolveDesktopWindowChromeMode({ platform: "darwin", override: "mac", isPackaged: false }),
    ).toThrow("Use windows or linux");
    expect(() =>
      resolveDesktopWindowChromeMode({
        platform: "darwin",
        override: "windows",
        isPackaged: true,
      }),
    ).toThrow("only available in development builds");
  });

  it("serializes the validated mode for preload", () => {
    expect(windowChromeModeArgument("custom-windows")).toBe(
      "--paseo-window-chrome-mode=custom-windows",
    );
  });
});
