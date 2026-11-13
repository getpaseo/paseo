import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { configureLinuxInputMethod } from "./linux-input-method.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(command: string): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "paseo-input-method-"));
  roots.push(root);
  const executable = join(root, "gdbus");
  writeFileSync(executable, `#!/bin/sh\n${command}\n`);
  chmodSync(executable, 0o755);
  return { PATH: root, DBUS_SESSION_BUS_ADDRESS: "unix:path=/test-session-bus" };
}

const it = test.runIf(process.platform !== "win32");

it("uses the running IBus portal instead of a cached private socket", () => {
  const env = environment("printf '(true,)\\n'");
  expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(true);
  expect(env.IBUS_USE_PORTAL).toBe("1");
});

it.each(["printf '(false,)\\n'", "exit 1", "printf 'unexpected response\\n'"])(
  "keeps the existing input method when the portal is unavailable: %s",
  (command) => {
    const env = environment(command);
    expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(false);
    expect(env.IBUS_USE_PORTAL).toBeUndefined();
  },
);

it("keeps working without gdbus installed", () => {
  const env = { PATH: "", DBUS_SESSION_BUS_ADDRESS: "unix:path=/test-session-bus" };
  expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(false);
  expect(env).not.toHaveProperty("IBUS_USE_PORTAL");
});

it("bounds the portal probe instead of hanging desktop startup", () => {
  const env = environment("while :; do :; done");
  expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(false);
  expect(env.IBUS_USE_PORTAL).toBeUndefined();
});

it("preserves an explicit IBus portal setting", () => {
  const env = { ...environment("exit 99"), IBUS_USE_PORTAL: "" };
  expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(false);
  expect(env.IBUS_USE_PORTAL).toBe("");
});

it.each(["darwin", "win32"] as const)("does not probe on %s", (platform) => {
  const env = environment("printf '(true,)\\n'");
  expect(configureLinuxInputMethod({ env, platform })).toBe(false);
  expect(env.IBUS_USE_PORTAL).toBeUndefined();
});

it("does not probe outside a desktop D-Bus session", () => {
  const env = environment("printf '(true,)\\n'");
  delete env.DBUS_SESSION_BUS_ADDRESS;
  expect(configureLinuxInputMethod({ env, platform: "linux" })).toBe(false);
  expect(env.IBUS_USE_PORTAL).toBeUndefined();
});
