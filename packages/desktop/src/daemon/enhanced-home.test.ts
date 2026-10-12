import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { initializeEnhancedDaemonHome } from "./enhanced-home";
test("creates an isolated private daemon configuration without overwriting existing settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-enhanced-home-"));
  try {
    await initializeEnhancedDaemonHome(home);
    const config = path.join(home, "config.json");
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      daemon: { listen: "127.0.0.1:6791" },
    });
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    const existing = '{"daemon":{"listen":"127.0.0.1:7991"},"custom":"preserved"}';
    await writeFile(config, existing);
    await Promise.all([initializeEnhancedDaemonHome(home), initializeEnhancedDaemonHome(home)]);
    expect(await readFile(config, "utf8")).toBe(existing);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
