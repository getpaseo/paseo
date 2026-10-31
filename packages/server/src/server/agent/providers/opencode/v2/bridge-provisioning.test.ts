import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { hasManagedBridge, provisionLocalBridge } from "./bridge-provisioning.js";

test("installs a watched plugin without changing existing OpenCode configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-provision-"));
  const source = path.join(root, "source.js");
  const config = path.join(root, "opencode.json");
  await writeFile(source, "export default { id: 'paseo' };");
  await writeFile(path.join(root, "state.mjs"), "export const state = new Map();");
  await writeFile(config, '{"plugins":["existing"]}\n');
  try {
    expect(await hasManagedBridge(root)).toBe(false);
    await Promise.all([
      provisionLocalBridge({ configDirectory: root, artifact: source }),
      provisionLocalBridge({ configDirectory: root, artifact: source }),
    ]);
    expect(await hasManagedBridge(root)).toBe(true);
    const manifest = path.join(root, "plugins/paseo-managed-bridge/package.json");
    const formatted = `${JSON.stringify(JSON.parse(await readFile(manifest, "utf8")), null, 2)}\n`;
    await writeFile(manifest, formatted);
    expect(await hasManagedBridge(root)).toBe(true);
    await provisionLocalBridge({ configDirectory: root, artifact: source });
    expect(await readFile(manifest, "utf8")).toBe(formatted);
    expect(await readFile(config, "utf8")).toBe('{"plugins":["existing"]}\n');
    expect(await readFile(path.join(root, "plugins/paseo-managed-bridge/state.mjs"), "utf8")).toBe(
      "export const state = new Map();",
    );
    expect(
      await readFile(path.join(root, "plugins/paseo-managed-bridge/server.js"), "utf8"),
    ).toContain("id: 'paseo'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
