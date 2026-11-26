import { describe, expect, test } from "vitest";
import {
  buildSelfNodeCommand,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  resolvePaseoNodeEnv,
  stripAppImageRuntimeEnv,
} from "./paseo-env.js";
import { stripAppImageRuntimeEnv as stripFromProcess } from "../utils/spawn.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
    ESBUILD_BINARY_PATH: "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/esbuild",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "ESBUILD_BINARY_PATH",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });

  test.runIf(process.platform === "linux")(
    "strips AppImage runtime variables and APPDIR path-list segments from external process env",
    () => {
      const appDir = "/tmp/.mount_Paseo-123456";
      const env = createExternalProcessEnv(
        {
          APPIMAGE: "/home/user/app/Paseo-x86_64.AppImage",
          APPDIR: `${appDir}/`,
          ARGV0: "/home/user/app/Paseo-x86_64.AppImage",
          OWD: "/home/user",
          APPIMAGE_LIBRARY_PATH: `${appDir}/usr/lib`,
          PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin:${appDir}2/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib;/custom/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share/`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          HOME: "/home/user",
        },
        {
          EXTRA: "1",
        },
      );

      expect("APPIMAGE" in env).toBe(false);
      expect("APPDIR" in env).toBe(false);
      expect("ARGV0" in env).toBe(false);
      expect("OWD" in env).toBe(false);
      expect("APPIMAGE_LIBRARY_PATH" in env).toBe(false);
      expect(env.PATH).toBe(`/usr/local/bin:/usr/bin:${appDir}2/bin`);
      expect(env.LD_LIBRARY_PATH).toBe("/custom/lib");
      expect(env.XDG_DATA_DIRS).toBe("/usr/share/");
      expect("GSETTINGS_SCHEMA_DIR" in env).toBe(false);
      expect(env.HOME).toBe("/home/user");
      expect(env.EXTRA).toBe("1");
    },
  );

  test.runIf(process.platform === "linux")(
    "preserves user ARGV0 when no AppImage runtime marker is set",
    () => {
      const env = createExternalProcessEnv({
        ARGV0: "/custom/argv0",
        PATH: "/usr/bin",
      });

      expect(env.ARGV0).toBe("/custom/argv0");
      expect(env.PATH).toBe("/usr/bin");
    },
  );

  test.runIf(process.platform === "linux")(
    "strips AppImage runtime vars from buildSelfNodeCommand",
    () => {
      const appDir = "/tmp/.mount_Paseo-selfnode";
      const saved = {
        APPIMAGE: process.env.APPIMAGE,
        APPDIR: process.env.APPDIR,
        ARGV0: process.env.ARGV0,
        OWD: process.env.OWD,
        PATH: process.env.PATH,
      };
      process.env.APPIMAGE = "/home/user/app/Paseo-x86_64.AppImage";
      process.env.APPDIR = appDir;
      process.env.ARGV0 = "/home/user/app/Paseo-x86_64.AppImage";
      process.env.OWD = "/home/user";
      process.env.PATH = `${appDir}:/usr/bin`;

      try {
        const command = buildSelfNodeCommand(["worker.js"]);
        expect("APPIMAGE" in command.env).toBe(false);
        expect("APPDIR" in command.env).toBe(false);
        expect("ARGV0" in command.env).toBe(false);
        expect("OWD" in command.env).toBe(false);
        expect(command.env.PATH).toBe("/usr/bin");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    },
  );
});

describe("stripAppImageRuntimeEnv", () => {
  test("re-exports the shared helper from the process entrypoint", () => {
    expect(stripFromProcess).toBe(stripAppImageRuntimeEnv);
  });

  test("is a no-op on non-Linux platforms", () => {
    const appDir = "/tmp/.mount_Paseo-darwin";
    const env: Record<string, string | undefined> = {
      APPIMAGE: "/Applications/Paseo.AppImage",
      APPDIR: appDir,
      ARGV0: "/Applications/Paseo.AppImage",
      OWD: "/Users/me",
      APPIMAGE_LIBRARY_PATH: `${appDir}/usr/lib`,
      PATH: `${appDir}:/usr/bin`,
    };

    stripAppImageRuntimeEnv(env, { platform: "darwin" });
    stripAppImageRuntimeEnv(env, { platform: "win32" });

    expect(env).toEqual({
      APPIMAGE: "/Applications/Paseo.AppImage",
      APPDIR: appDir,
      ARGV0: "/Applications/Paseo.AppImage",
      OWD: "/Users/me",
      APPIMAGE_LIBRARY_PATH: `${appDir}/usr/lib`,
      PATH: `${appDir}:/usr/bin`,
    });
  });

  test("is a no-op when APPIMAGE and APPDIR are missing or empty", () => {
    const env: Record<string, string | undefined> = {
      APPIMAGE: "",
      APPDIR: "",
      ARGV0: "/usr/local/bin/my-wrapper",
      OWD: "/home/user",
      PATH: "/usr/local/bin:/usr/bin",
    };

    stripAppImageRuntimeEnv(env, { platform: "linux" });

    expect(env).toEqual({
      APPIMAGE: "",
      APPDIR: "",
      ARGV0: "/usr/local/bin/my-wrapper",
      OWD: "/home/user",
      PATH: "/usr/local/bin:/usr/bin",
    });
  });

  test("deletes empty path-list keys while preserving intentional empty segments", () => {
    const appDir = "/tmp/.mount_Paseo-segments";
    const env: Record<string, string | undefined> = {
      APPIMAGE: "/home/user/Paseo.AppImage",
      APPDIR: `${appDir}/./`,
      ARGV0: "/home/user/Paseo.AppImage",
      PATH: `${appDir}::/usr/bin:`,
      LD_LIBRARY_PATH: `${appDir}/usr/lib;${appDir}/lib`,
      XDG_DATA_DIRS: `${appDir}/usr/share::/usr/share`,
      GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
    };

    stripAppImageRuntimeEnv(env, { platform: "linux" });

    expect(env.PATH).toBe(":/usr/bin:");
    expect("LD_LIBRARY_PATH" in env).toBe(false);
    expect(env.XDG_DATA_DIRS).toBe(":/usr/share");
    expect("GSETTINGS_SCHEMA_DIR" in env).toBe(false);
  });

  test("preserves lone empty segment colon when AppDir is removed from PATH", () => {
    const appDir = "/tmp/.mount_Paseo-colon";
    const env: Record<string, string | undefined> = {
      APPDIR: appDir,
      PATH: `${appDir}::`,
    };

    stripAppImageRuntimeEnv(env, { platform: "linux" });

    expect(env.PATH).toBe(":");
  });

  test("ignores non-absolute or root APPDIR when scrubbing path lists", () => {
    const relativeEnv: Record<string, string | undefined> = {
      APPIMAGE: "/home/user/Paseo.AppImage",
      APPDIR: "relative/appdir",
      ARGV0: "/home/user/Paseo.AppImage",
      PATH: "relative/appdir:/usr/bin",
    };
    stripAppImageRuntimeEnv(relativeEnv, { platform: "linux" });
    expect("APPIMAGE" in relativeEnv).toBe(false);
    expect("APPDIR" in relativeEnv).toBe(false);
    expect("ARGV0" in relativeEnv).toBe(false);
    expect(relativeEnv.PATH).toBe("relative/appdir:/usr/bin");

    const rootEnv: Record<string, string | undefined> = {
      APPIMAGE: "/home/user/Paseo.AppImage",
      APPDIR: "/",
      ARGV0: "/home/user/Paseo.AppImage",
      PATH: "/usr/local/bin:/usr/bin",
    };
    stripAppImageRuntimeEnv(rootEnv, { platform: "linux" });
    expect("APPIMAGE" in rootEnv).toBe(false);
    expect("APPDIR" in rootEnv).toBe(false);
    expect("ARGV0" in rootEnv).toBe(false);
    expect(rootEnv.PATH).toBe("/usr/local/bin:/usr/bin");
  });
});
