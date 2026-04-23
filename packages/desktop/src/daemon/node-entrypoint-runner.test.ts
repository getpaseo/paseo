import { describe, expect, it } from "vitest";
import { sanitizeNodeEntrypointEnv } from "./node-entrypoint-runner";

describe("node-entrypoint-runner", () => {
  it("removes Electron node-mode env before loading the target entrypoint", () => {
    const env = {
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      PATH: "/usr/bin",
    };

    sanitizeNodeEntrypointEnv(env);

    expect(env).toEqual({
      PATH: "/usr/bin",
    });
  });
});
