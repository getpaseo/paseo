import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// The launcher reads Linux /proc state as well as POSIX command interfaces.
const it = test.runIf(process.platform === "linux");

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/after-pack.js").default;

async function launch(
  options: {
    namespaces?: boolean;
    helper?: string;
    mount?: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
    symlink?: boolean;
    rerun?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paseo-launcher-"));
  try {
    const app = join(root, "app with spaces");
    const commands = join(root, "commands");
    mkdirSync(app);
    mkdirSync(commands);
    writeFileSync(
      join(app, "Paseo"),
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(join(app, "Paseo"), 0o755);
    // The command interface represents the host's userns policy, independent of CI's host.
    writeFileSync(join(commands, "unshare"), `#!/bin/sh\nexit ${options.namespaces ? 0 : 1}\n`);
    chmodSync(join(commands, "unshare"), 0o755);
    for (const [name, output] of Object.entries({
      stat: options.helper ?? "1000:755",
      findmnt: options.mount ?? "rw",
    })) {
      writeFileSync(join(commands, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      chmodSync(join(commands, name), 0o755);
    }
    writeFileSync(join(app, "chrome-sandbox"), "helper");
    chmodSync(join(app, "chrome-sandbox"), 0o755);
    await afterPack({ appOutDir: app, electronPlatformName: "linux", arch: 1 });
    if (options.rerun) await afterPack({ appOutDir: app, electronPlatformName: "linux", arch: 1 });
    const executablePath = options.symlink ? join(root, "paseo") : join(app, "Paseo");
    if (options.symlink) symlinkSync(join(app, "Paseo"), executablePath);
    const args = options.args ?? ["path with spaces", "$(touch never)", "semi;colon", "*.txt"];
    const result = spawnSync(executablePath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        PATH: `${commands}:${process.env.PATH}`,
        APPIMAGE: "/tmp/Paseo.AppImage",
        PASEO_DESKTOP_SMOKE: "0",
        ...options.env,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return { args: JSON.parse(result.stdout), stderr: result.stderr, input: args };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("launches a portable app with the fallback on argv when user namespaces are denied", async () => {
  const result = await launch();
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
  expect(result.stderr).toContain("[linux-sandbox] disabled");
});

it("keeps sandboxing for AppImage when the real user can create namespaces", async () => {
  const result = await launch({ namespaces: true });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] enabled: user namespaces available");
});

it("keeps sandboxing via the installed root-owned helper when userns is denied", async () => {
  const result = await launch({ helper: "0:4755", env: { APPIMAGE: "" } });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] enabled: root-owned SUID helper available");
});

it("does not trust 4755 on a nosuid mount", async () => {
  const result = await launch({ helper: "0:4755", mount: "rw,nosuid,nodev" });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("preserves sandbox flags and all Node entrypoint arguments without probing", async () => {
  const result = await launch({ env: { ELECTRON_RUN_AS_NODE: "1" }, args: ["--version"] });
  expect(result.args).toEqual(["--version"]);
  expect(result.stderr).toBe("");
});

it("reports an explicit user override without injecting a duplicate", async () => {
  const result = await launch({ namespaces: true, args: ["--no-sandbox", "--version"] });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] disabled: requested by --no-sandbox");
});

it("resolves symlink launches and keeps the real executable intact on repeated packaging", async () => {
  const result = await launch({ symlink: true, rerun: true });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("does not depend on APPIMAGE being present for an extracted portable app", async () => {
  const result = await launch({ env: { APPIMAGE: "" } });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("applies a debugging environment sandbox override before Chromium starts", async () => {
  const result = await launch({
    namespaces: true,
    env: { PASEO_ELECTRON_FLAGS: "--disable-gpu\t--no-sandbox" },
  });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
  expect(result.stderr).toContain("requested by PASEO_ELECTRON_FLAGS");
});
