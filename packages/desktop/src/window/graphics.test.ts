import { describe, expect, test } from "vitest";
import { configureDesktopGraphics } from "./graphics.js";

class CommandLine {
  constructor(public readonly switches = new Map<string, string>()) {}
  appendSwitch(name: string, value = "") {
    this.switches.set(name, value);
  }
}

describe("desktop graphics", () => {
  test("uses XWayland when an X display is available in a Wayland session", () => {
    const commandLine = new CommandLine(new Map([["ozone-platform", "wayland"]]));
    configureDesktopGraphics({ argv: [], platform: "linux", display: ":0", commandLine });
    expect(commandLine.switches).toEqual(new Map([["ozone-platform", "x11"]]));
  });

  test.each(["ozone-platform", "ozone-platform-hint"])(
    "preserves an explicit %s selection",
    (name) => {
      const commandLine = new CommandLine(new Map([[name, "wayland"]]));
      configureDesktopGraphics({
        argv: [`--${name}=wayland`],
        platform: "linux",
        display: ":0",
        commandLine,
      });
      expect(commandLine.switches).toEqual(new Map([[name, "wayland"]]));
    },
  );

  test.each([undefined, ""])("leaves a session without an X display unchanged (%s)", (display) => {
    const commandLine = new CommandLine();
    configureDesktopGraphics({ argv: [], platform: "linux", display, commandLine });
    expect(commandLine.switches.size).toBe(0);
  });

  test.each(["darwin", "win32"] as const)("leaves %s unchanged", (platform) => {
    const commandLine = new CommandLine();
    configureDesktopGraphics({ argv: [], platform, display: ":0", commandLine });
    expect(commandLine.switches.size).toBe(0);
  });
});
