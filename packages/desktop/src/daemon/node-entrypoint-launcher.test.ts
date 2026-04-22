import { describe, expect, it } from "vitest";
import {
  createNodeEntrypointInvocation,
  parseCliPassthroughArgsFromArgv,
  type NodeEntrypointSpec,
} from "./node-entrypoint-launcher";

const CLI_ENTRYPOINT: NodeEntrypointSpec = {
  entryPath: "/tmp/paseo-cli.js",
  execArgv: ["--import", "tsx"],
};

describe("node-entrypoint-launcher", () => {
  describe("parseCliPassthroughArgsFromArgv", () => {
    it("returns null when no CLI args are provided", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toBeNull();
    });

    it("ignores macOS GUI launch arguments", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "-psn_0_12345"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toBeNull();
    });

    it("ignores --no-sandbox injected by Linux wrapper", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/usr/bin/Paseo", "--no-sandbox", "status"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toEqual(["status"]);
    });

    it("returns null when only --no-sandbox is present", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/usr/bin/Paseo", "--no-sandbox"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toBeNull();
    });

    it("preserves CLI flags for direct app invocations", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--version"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toEqual(["--version"]);
    });

    it("passes --open-project through as a normal CLI arg", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--open-project", "/tmp/project"],
          isDefaultApp: false,
          forceCli: false,
        }),
      ).toEqual(["--open-project", "/tmp/project"]);
    });

    it("forces CLI mode for shim launches even without args", () => {
      expect(
        parseCliPassthroughArgsFromArgv({
          argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo"],
          isDefaultApp: false,
          forceCli: true,
        }),
      ).toEqual([]);
    });
  });

  describe("createNodeEntrypointInvocation", () => {
    it("uses the packaged runner when the desktop app is packaged", () => {
      expect(
        createNodeEntrypointInvocation({
          execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
          isPackaged: true,
          packagedRunnerPath:
            "/Applications/Paseo.app/Contents/Resources/app.asar/dist/daemon/node-entrypoint-runner.js",
          entrypoint: CLI_ENTRYPOINT,
          argvMode: "node-script",
          args: ["ls", "--json"],
          baseEnv: { PATH: "/usr/bin" },
        }),
      ).toEqual({
        command: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        args: [
          "--disable-warning=DEP0040",
          "/Applications/Paseo.app/Contents/Resources/app.asar/dist/daemon/node-entrypoint-runner.js",
          "node-script",
          "/tmp/paseo-cli.js",
          "ls",
          "--json",
        ],
        env: {
          PATH: "/usr/bin",
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
        },
      });
    });

    it("uses the entrypoint directly in development", () => {
      expect(
        createNodeEntrypointInvocation({
          execPath: "/opt/homebrew/bin/electron",
          isPackaged: false,
          packagedRunnerPath: null,
          entrypoint: CLI_ENTRYPOINT,
          argvMode: "node-script",
          args: ["ls"],
          baseEnv: { PATH: "/usr/bin" },
        }),
      ).toEqual({
        command: "/opt/homebrew/bin/electron",
        args: ["--import", "tsx", "/tmp/paseo-cli.js", "ls"],
        env: {
          PATH: "/usr/bin",
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    });

    it("forces packaged launches to production even when NODE_ENV is inherited as development", () => {
      expect(
        createNodeEntrypointInvocation({
          execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
          isPackaged: true,
          packagedRunnerPath:
            "/Applications/Paseo.app/Contents/Resources/app.asar/dist/daemon/node-entrypoint-runner.js",
          entrypoint: CLI_ENTRYPOINT,
          argvMode: "node-script",
          args: [],
          baseEnv: { PATH: "/usr/bin", NODE_ENV: "development" },
        }).env,
      ).toMatchObject({
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
      });
    });

    it("keeps node-style argv for packaged script entrypoints", () => {
      expect(
        createNodeEntrypointInvocation({
          execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
          isPackaged: true,
          packagedRunnerPath:
            "/Applications/Paseo.app/Contents/Resources/app.asar/dist/daemon/node-entrypoint-runner.js",
          entrypoint: CLI_ENTRYPOINT,
          argvMode: "node-script",
          args: ["--dev"],
          baseEnv: { PATH: "/usr/bin" },
        }),
      ).toEqual({
        command: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        args: [
          "--disable-warning=DEP0040",
          "/Applications/Paseo.app/Contents/Resources/app.asar/dist/daemon/node-entrypoint-runner.js",
          "node-script",
          "/tmp/paseo-cli.js",
          "--dev",
        ],
        env: {
          PATH: "/usr/bin",
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
        },
      });
    });
  });
});
