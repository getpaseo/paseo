import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolvePaseoPaths, XDG_LAYOUT_MARKER } from "./paseo-paths.js";

const created: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-paths-home-"));
  created.push(home);
  return home;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("resolvePaseoPaths", () => {
  test("PASEO_HOME keeps every category in one flat directory", () => {
    const home = makeHome();
    const paseoHome = path.join(home, "custom");

    const paths = resolvePaseoPaths({ PASEO_HOME: paseoHome }, "linux", home);

    expect(paths.layout).toBe("flat");
    expect([paths.home, paths.config, paths.data, paths.state, paths.cache]).toEqual([
      paseoHome,
      paseoHome,
      paseoHome,
      paseoHome,
      paseoHome,
    ]);
  });

  test("an empty PASEO_HOME retains the previous current-directory behavior", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths({ PASEO_HOME: "" }, "linux", home);

    expect(paths.layout).toBe("flat");
    expect(paths.home).toBe(process.cwd());
  });

  test("an existing ~/.paseo keeps the current layout, ignoring XDG variables", () => {
    const home = makeHome();
    const legacy = path.join(home, ".paseo");
    mkdirSync(legacy);

    const paths = resolvePaseoPaths(
      {
        XDG_CONFIG_HOME: path.join(home, "xdg-config"),
        XDG_CACHE_HOME: path.join(home, "xdg-cache"),
      },
      "linux",
      home,
    );

    expect(paths.layout).toBe("flat");
    expect(paths.config).toBe(legacy);
    expect(paths.cache).toBe(legacy);
    expect(existsSync(path.join(home, "xdg-config"))).toBe(false);
  });

  test("a fresh install splits the categories across XDG roots", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths({}, "linux", home);

    expect(paths.layout).toBe("xdg");
    expect(paths.config).toBe(path.join(home, ".config", "paseo"));
    expect(paths.data).toBe(path.join(home, ".local", "share", "paseo"));
    expect(paths.home).toBe(paths.data);
  });

  test("state and cache share the data root until they are split", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths({}, "linux", home);

    expect(paths.state).toBe(paths.data);
    expect(paths.cache).toBe(paths.data);
  });

  test("a fresh install honors the XDG variables when they are set", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths(
      {
        XDG_CONFIG_HOME: path.join(home, "conf"),
        XDG_DATA_HOME: "~/dat",
      },
      "linux",
      home,
    );

    expect(paths.config).toBe(path.join(home, "conf", "paseo"));
    expect(paths.data).toBe(path.join(home, "dat", "paseo"));
  });

  test("relative XDG roots are invalid and fall back to their defaults", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths(
      {
        XDG_CONFIG_HOME: "relative-config",
        XDG_DATA_HOME: "relative-data",
      },
      "linux",
      home,
    );

    expect(paths.config).toBe(path.join(home, ".config", "paseo"));
    expect(paths.data).toBe(path.join(home, ".local", "share", "paseo"));
  });

  test("resolving creates nothing at all", () => {
    const home = makeHome();

    const paths = resolvePaseoPaths({}, "linux", home);

    // Creating ~/.paseo would silently pin every later call to the flat layout, and creating the
    // XDG roots would make merely asking for a path a side effect on someone else's home.
    expect(existsSync(path.join(home, ".paseo"))).toBe(false);
    expect(existsSync(paths.config)).toBe(false);
    expect(existsSync(paths.data)).toBe(false);
  });

  test("the layout a process starts with is the layout it keeps", () => {
    const home = makeHome();
    const env = {};

    const before = resolvePaseoPaths(env, "linux", home);
    expect(before.layout).toBe("xdg");

    // An older release, or any other tool, creating this while the daemon runs must not move
    // config out from under it: the data root would stay put while config.json silently moved.
    mkdirSync(path.join(home, ".paseo"));

    const after = resolvePaseoPaths(env, "linux", home);
    expect(after.layout).toBe("xdg");
    expect(after.config).toBe(before.config);
  });

  test("environment changes cannot move a running process to different roots", () => {
    const home = makeHome();
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: path.join(home, "config-before"),
      XDG_DATA_HOME: path.join(home, "data-before"),
    };

    const before = resolvePaseoPaths(env, "linux", home);
    env.XDG_CONFIG_HOME = path.join(home, "config-after");
    env.XDG_DATA_HOME = path.join(home, "data-after");

    expect(resolvePaseoPaths(env, "linux", home)).toEqual(before);
  });

  test("an XDG install stays XDG across process restarts if ~/.paseo later appears", () => {
    const home = makeHome();
    const data = path.join(home, ".local", "share", "paseo");
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, XDG_LAYOUT_MARKER), "1\n");
    mkdirSync(path.join(home, ".paseo"));

    const paths = resolvePaseoPaths({}, "linux", home);

    expect(paths.layout).toBe("xdg");
    expect(paths.data).toBe(data);
  });

  test.each(["darwin", "win32"] as const)(
    "%s keeps the flat layout instead of borrowing Linux conventions",
    (platform) => {
      const home = makeHome();

      const paths = resolvePaseoPaths({ XDG_CONFIG_HOME: path.join(home, "conf") }, platform, home);

      expect(paths.layout).toBe("flat");
      expect(paths.config).toBe(path.join(home, ".paseo"));
    },
  );
});
