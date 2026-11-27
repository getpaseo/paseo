import { describe, expect, test } from "vitest";
import { daemonLaunchEnvironment } from "./config-environment.js";

describe("daemonLaunchEnvironment AppImage sanitization", () => {
  const appDir = "/tmp/.mount_Paseo-abcdef";

  test("strips AppImage runtime variables in both managed and deployment modes", () => {
    const inputEnv: NodeJS.ProcessEnv = {
      APPIMAGE: "/home/user/app/Paseo-x86_64.AppImage",
      APPDIR: appDir,
      ARGV0: "/home/user/app/Paseo-x86_64.AppImage",
      OWD: "/home/user",
      APPIMAGE_LIBRARY_PATH: `${appDir}/usr/lib`,
      PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${appDir}/usr/lib:/opt/lib`,
      XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share`,
      GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
      PASEO_LOG_LEVEL: "debug",
    };

    for (const mode of ["managed", "deployment"] as const) {
      const result = daemonLaunchEnvironment({
        env: inputEnv,
        home: "/home/user/.paseo",
        mode,
        desktopManaged: mode === "managed",
        platform: "linux",
      });

      expect("APPIMAGE" in result).toBe(false);
      expect("APPDIR" in result).toBe(false);
      expect("ARGV0" in result).toBe(false);
      expect("OWD" in result).toBe(false);
      expect("APPIMAGE_LIBRARY_PATH" in result).toBe(false);
      expect(result.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(result.LD_LIBRARY_PATH).toBe("/opt/lib");
      expect(result.XDG_DATA_DIRS).toBe("/usr/local/share");
      expect("GSETTINGS_SCHEMA_DIR" in result).toBe(false);
      expect(result.PASEO_HOME).toBe("/home/user/.paseo");
      if (mode === "managed") {
        expect(result.PASEO_DESKTOP_MANAGED).toBe("1");
        expect(result.PASEO_LOG_LEVEL).toBeUndefined();
      } else {
        expect(result.PASEO_DESKTOP_MANAGED).toBeUndefined();
        expect(result.PASEO_LOG_LEVEL).toBe("debug");
      }
    }
  });

  test("preserves user ARGV0 without APPIMAGE or APPDIR", () => {
    const result = daemonLaunchEnvironment({
      env: {
        ARGV0: "/usr/local/bin/custom-wrapper",
        PATH: "/usr/bin",
      },
      home: "/home/user/.paseo",
      mode: "managed",
      platform: "linux",
    });

    expect(result.ARGV0).toBe("/usr/local/bin/custom-wrapper");
    expect(result.PATH).toBe("/usr/bin");
  });

  test("is a no-op on non-Linux platforms", () => {
    const darwinAppDir = "/tmp/.mount_Paseo-darwin";
    const result = daemonLaunchEnvironment({
      env: {
        APPIMAGE: "/Applications/Paseo.AppImage",
        APPDIR: darwinAppDir,
        ARGV0: "/Applications/Paseo.AppImage",
        PATH: `${darwinAppDir}:/usr/bin`,
      },
      home: "/Users/me/.paseo",
      mode: "managed",
      platform: "darwin",
    });

    expect(result.APPIMAGE).toBe("/Applications/Paseo.AppImage");
    expect(result.APPDIR).toBe(darwinAppDir);
    expect(result.ARGV0).toBe("/Applications/Paseo.AppImage");
    expect(result.PATH).toBe(`${darwinAppDir}:/usr/bin`);
  });
});
