import { describe, expect, test } from "vitest";

import { hostWorkspaceHelper } from "./host-helper.js";

describe("hostWorkspaceHelper", () => {
  test("uses the external host environment plus Electron Node mode", () => {
    expect(hostWorkspaceHelper.env.PATH).toBe(process.env.PATH);
    expect(hostWorkspaceHelper.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(hostWorkspaceHelper.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(hostWorkspaceHelper.env.PASEO_SUPERVISED).toBeUndefined();
  });
});
