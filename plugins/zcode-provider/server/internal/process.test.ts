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
    // The fake answers a session read with the settings the catalog is
    // projected from.
    await expect(zcode.rpc.call("session/read", { sessionId: "s1" })).resolves.toMatchObject({
      settings: { mode: { current: "plan" } },
    });
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

  test("reports a child that dies after it started", async () => {
    // The child starts fine and answers its first request, so `ready` stays
    // resolved. A crash afterwards is only visible on the exit promise.
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "crash" },
    });
    await zcode.ready;
    await expect(zcode.exited).rejects.toThrow(/exited with code/);
    await zcode.exit();
  });
});
