import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "zcode-setup.js");

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
