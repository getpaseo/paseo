import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  editPersistedConfig,
  getPersistedConfigValue,
  readPersistedConfig,
} from "./persisted-config.js";

test("configuration edits validate before writing and preserve unrelated settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-config-edit-"));
  const home = path.join(root, "home");
  try {
    expect(readPersistedConfig(home)).toEqual({});
    expect(existsSync(home)).toBe(false);
    for (const field of [
      "unknown",
      "daemon.missing",
      "daemon.__proto__.listen",
      "daemon.auth.password",
    ]) {
      expect(() => editPersistedConfig(home, field, { value: "value" })).toThrow();
      expect(existsSync(home)).toBe(false);
    }
    editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:12345" });
    editPersistedConfig(home, "features.webUi.enabled", { value: true });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    expect(() => editPersistedConfig(home, "features.webUi.enabled", { value: "true" })).toThrow();
    expect(() =>
      editPersistedConfig(home, "daemon", { value: { auth: { password: "plaintext" } } }),
    ).toThrow(/set-password/);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
    editPersistedConfig(home, "features.webUi.enabled", { unset: true });
    const edited = readPersistedConfig(home);
    expect(getPersistedConfigValue(edited, "features.webUi.enabled")).toBeUndefined();
    expect(edited.daemon?.listen).toBe("127.0.0.1:12345");
    await writeFile(path.join(home, "config.json"), "invalid json");
    expect(() => editPersistedConfig(home, "daemon.listen", { value: "12345" })).toThrow();
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe("invalid json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
