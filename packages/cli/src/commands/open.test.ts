import { describe, expect, it } from "vitest";
import { resolveDesktopLaunch } from "./open.js";

describe("desktop launch", () => {
  it("passes the AppImage sandbox flag before a project path containing spaces", () => {
    expect(
      resolveDesktopLaunch({
        platform: "linux",
        desktopApp: "/home/user/Applications/Paseo.AppImage",
        args: ["/home/user/My project"],
      }),
    ).toEqual({
      command: "/home/user/Applications/Paseo.AppImage",
      args: ["--no-sandbox", "/home/user/My project"],
    });
  });

  it.each(["/usr/bin/Paseo", "/opt/Paseo/Paseo"])(
    "keeps sandboxing enabled for the native Linux package at %s",
    (desktopApp) => {
      expect(
        resolveDesktopLaunch({ platform: "linux", desktopApp, args: ["/home/user/project"] }),
      ).toEqual({ command: desktopApp, args: ["/home/user/project"] });
    },
  );

  it("uses the same AppImage launch settings for agent deep links", () => {
    const deepLink = "paseo://agent?serverId=local&agentId=example";
    expect(
      resolveDesktopLaunch({
        platform: "linux",
        desktopApp: "/home/user/Applications/Paseo.AppImage",
        args: [deepLink],
      }),
    ).toEqual({
      command: "/home/user/Applications/Paseo.AppImage",
      args: ["--no-sandbox", deepLink],
    });
  });

  it("opens a separate macOS instance to forward the project path", () => {
    expect(
      resolveDesktopLaunch({
        platform: "darwin",
        desktopApp: "/Applications/Paseo.app",
        args: ["/Users/user/My project"],
      }),
    ).toEqual({
      command: "open",
      args: ["-n", "-g", "-a", "/Applications/Paseo.app", "--args", "/Users/user/My project"],
    });
  });

  it("launches Windows without Linux flags", () => {
    const desktopApp = "C:\\Users\\user\\Programs\\Paseo\\Paseo.exe";
    expect(
      resolveDesktopLaunch({ platform: "win32", desktopApp, args: ["C:\\My project"] }),
    ).toEqual({ command: desktopApp, args: ["C:\\My project"] });
  });
});
