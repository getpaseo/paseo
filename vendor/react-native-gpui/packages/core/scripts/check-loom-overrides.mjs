#!/usr/bin/env node
// Fails when a file Loom changes, and that a Loom variant in
// ReactCommonOverrides.loom was copied from, is not the one the pinned Loom
// ships any more. Run it after moving the pin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const require = createRequire(import.meta.url);
const { materializedTree } = require('../renderer.js');
const overrides = JSON.parse(
  readFileSync(path.join(packageDir, 'overrides.json'), 'utf8'),
);

const tree = await materializedTree(packageDir);
const stale = [];
let checked = 0;
for (const override of overrides.overrides) {
  if (!override.loomBaseFile) continue;
  checked += 1;
  const actual = createHash('sha256')
    .update(readFileSync(path.join(tree.reactNativeDir, override.loomBaseFile)))
    .digest('hex');
  if (actual !== override.loomBaseHash) {
    stale.push(`${override.file}: ${override.loomBaseFile} is now ${actual}`);
  }
}
if (stale.length > 0) {
  console.error(
    `Loom ${tree.loomVersion} changed files a Loom variant was copied from:\n  ${stale.join('\n  ')}\nCarry the change over to the variant and update loomBaseHash.`,
  );
  process.exit(1);
}
console.log(`${checked} Loom variants match Loom ${tree.loomVersion}`);
