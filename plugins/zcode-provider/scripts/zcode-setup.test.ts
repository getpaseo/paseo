import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "zcode-setup.js");

/**
 * The shell the documented flow runs in.
 *
 * `read -s` is a Bash builtin. `/bin/sh` is dash on Ubuntu, and dash rejects
 * the option, so the flow needs Bash itself.
 */
function findBash(): string | undefined {
  if (process.platform === "win32") {
    // Windows has no Bash by default, and the documented flow is the one for
    // a POSIX shell.
    return undefined;
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const bashPath = findBash();

function addProvider(configFile: string): void {
  execFileSync(
    process.execPath,
    [
      script,
      "add-provider",
      "--name",
      "BigModel Team CodingPlan",
      "--api-key-env",
      "ZCODE_SETUP_TEST_KEY",
      "--kind",
      "team",
      "--config-file",
      configFile,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ZCODE_SETUP_TEST_KEY: "test-key" },
    },
  );
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

// Windows has no POSIX modes: the config is protected by the user's ACL
// instead, which the script cannot check.
describe.skipIf(process.platform === "win32")("zcode setup config permissions", () => {
  test("writes a new provider config readable by its owner only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-setup-"));
    const configFile = join(dir, "provider_config.json");

    addProvider(configFile);

    expect(await modeOf(configFile)).toBe(0o600);
  });

  test("tightens an existing config and the backup it takes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-setup-"));
    const configFile = join(dir, "provider_config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        config: { providerConfigRules: { templateRules: [], providerRules: [] } },
      }),
    );
    await chmod(configFile, 0o644);

    addProvider(configFile);

    const backup = (await readdir(dir)).find((name) => name.includes(".bak-"));
    expect(backup).toBeDefined();
    expect(await modeOf(configFile)).toBe(0o600);
    expect(await modeOf(join(dir, backup!))).toBe(0o600);
  });
});

/**
 * The README documents a shell flow for entering the key without echoing it.
 * The script reads the key from the environment, so the flow has to export
 * the variable; a shell variable that is never exported is invisible to the
 * script and the setup fails with a usage error.
 */
describe.skipIf(bashPath === undefined)("zcode setup documented key flow", () => {
  test("registers a provider from a key read without echoing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-setup-"));
    const configFile = join(dir, "provider_config.json");

    // The documented flow, with the key piped in instead of typed.
    const run = spawnSync(
      bashPath ?? "/bin/sh",
      [
        "-c",
        [
          "IFS= read -rs ZCODE_SETUP_API_KEY",
          "export ZCODE_SETUP_API_KEY",
          `"${process.execPath}" "${script}" add-provider --name "BigModel Team CodingPlan" --api-key-env ZCODE_SETUP_API_KEY --kind team --config-file "${configFile}"`,
        ].join("\n"),
      ],
      { encoding: "utf8", input: "test-key\n", env: { PATH: process.env.PATH ?? "" } },
    );

    expect(run.status).toBe(0);
    const config = JSON.parse(await readFile(configFile, "utf8")) as {
      config: {
        providerConfigRules: { providerRules: Array<{ config: { access: { apiKey: string } } }> };
      };
    };
    expect(config.config.providerConfigRules.providerRules[0]?.config.access.apiKey).toBe(
      "test-key",
    );
  });
});
