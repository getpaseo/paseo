import { describe, expect, test } from "vitest";
import {
  ensureForgeCliWithDefaults,
  isForgeCliAutoInstallEnabled,
} from "./forge-cli-autoinstall-default.js";

describe("isForgeCliAutoInstallEnabled", () => {
  test("defaults to enabled when the env var is unset", () => {
    expect(isForgeCliAutoInstallEnabled({})).toBe(true);
  });

  test("disables when PASEO_FORGE_CLI_AUTOINSTALL is falsy", () => {
    expect(isForgeCliAutoInstallEnabled({ PASEO_FORGE_CLI_AUTOINSTALL: "0" })).toBe(false);
    expect(isForgeCliAutoInstallEnabled({ PASEO_FORGE_CLI_AUTOINSTALL: "false" })).toBe(false);
  });

  test("enables when PASEO_FORGE_CLI_AUTOINSTALL is truthy", () => {
    expect(isForgeCliAutoInstallEnabled({ PASEO_FORGE_CLI_AUTOINSTALL: "1" })).toBe(true);
  });
});

describe("ensureForgeCliWithDefaults", () => {
  test("short-circuits to null without touching the network when auto-install is disabled", async () => {
    const result = await ensureForgeCliWithDefaults("tea", { autoInstallEnabled: false });
    expect(result).toBeNull();
  });
});
