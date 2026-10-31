import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { startZCodeProcess } from "./process.js";

const fakeServer = fileURLToPath(new URL("../../test/fake-zcode-app-server.mjs", import.meta.url));

describe("ZCode process lifecycle", () => {
  test("answers a call over the child's stdio", async () => {
    // The binding is not named `process`: it would shadow the global inside
    // its own initializer and `process.execPath` would throw a TDZ error.
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    await expect(zcode.rpc.call("session/read", { sessionId: "s1" })).resolves.toEqual({});
    await zcode.exit();
  });

  test("reports a startup failure with the child's stderr", async () => {
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "stderr" },
    });
    await expect(zcode.ready).rejects.toThrow(/runtime missing/);
    await zcode.exit();
  });
});
