import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_PLUGINS } from "../packages/server/dist/server/plugins/index.js";

const pluginRoot = fileURLToPath(
  new URL("../packages/server/dist/server/plugins/", import.meta.url),
);

assert.ok(INTERNAL_PLUGINS.length > 0, "The built daemon must list internal plugins");
for (const plugin of INTERNAL_PLUGINS) {
  assert.equal(path.resolve(plugin.directory), path.join(pluginRoot, plugin.id));
  const manifestPath = path.join(plugin.directory, "paseo-plugin.json");
  assert.ok((await stat(manifestPath)).isFile(), `${plugin.id} manifest must be a file`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.id, plugin.id);

  const icons = [];
  await plugin.contribute({
    registerUsageSource(source) {
      if (source.icon) icons.push(source.icon);
    },
  });
  for (const icon of icons) {
    assert.ok(
      (await stat(path.join(plugin.directory, icon))).isFile(),
      `${plugin.id} icon must be a file`,
    );
  }
}

console.log(`Verified built assets for ${INTERNAL_PLUGINS.length} internal plugins`);
