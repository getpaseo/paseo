import { describe, expect, test } from "vitest";

import { daemonLaunchEnvironment } from "./config-environment.js";
import { resolvePaseoHome } from "./paseo-home.js";

describe("daemonLaunchEnvironment", () => {
  test("the launched daemon resolves the selected home even when PANDAOS_HOME is inherited", () => {
    const env = daemonLaunchEnvironment({
      env: { PANDAOS_HOME: "/real/home", PASEO_HOME: "/other" },
      home: "/selected",
      mode: "managed",
    });

    expect(env.PANDAOS_HOME).toBeUndefined();
    expect(env.PASEO_HOME).toBe("/selected");
    expect(resolvePaseoHome(env)).toBe("/selected");
  });
});
