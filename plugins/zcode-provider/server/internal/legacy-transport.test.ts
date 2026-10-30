import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { startZCodeProcess } from "./process.js";
import { createLegacyTransport } from "./legacy-transport.js";

const fakeServer = fileURLToPath(new URL("../../test/fake-zcode-app-server.mjs", import.meta.url));

describe("legacy ZCode transport", () => {
  test("sends a prompt and acknowledges it", async () => {
    // The binding is not named `process`: it would shadow the global inside
    // its own initializer and `process.execPath` would throw a TDZ error.
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    const transport = createLegacyTransport(zcode);
    await transport.createSession({
      workspace: { workspacePath: "/tmp/project", workspaceKey: "/tmp/project" },
    });
    await expect(
      transport.send({ sessionId: "s1", content: "hello", inputId: "input-1" }),
    ).resolves.toBeUndefined();
    await transport.close();
    await zcode.exit();
  });

  test("does not advertise rewind or steer", async () => {
    const zcode = startZCodeProcess({
      command: process.execPath,
      args: [fakeServer],
      env: { ...process.env, FAKE_ZCODE_MODE: "ok" },
    });
    const transport = createLegacyTransport(zcode);
    expect(transport.capabilities).not.toContain("session.revert.conversation");
    expect(transport.capabilities).not.toContain("prompt.steer");
    expect(transport.capabilities).toContain("prompt.message");
    await transport.close();
    await zcode.exit();
  });
});
