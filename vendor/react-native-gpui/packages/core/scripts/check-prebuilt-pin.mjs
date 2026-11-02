#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

if (process.env.RN_GPUI_SKIP_PREBUILT_PIN_CHECK === '1') {
  console.warn(
    'check-prebuilt-pin: RN_GPUI_SKIP_PREBUILT_PIN_CHECK=1; skipping the pin check.',
  );
  process.exit(0);
}

const pin = JSON.parse(
  readFileSync(path.join(packageDir, 'prebuilt-binaries.json'), 'utf8'),
);

const hashRun = spawnSync(
  process.execPath,
  [path.join(scriptDir, 'prebuilt-inputs.mjs')],
  { encoding: 'utf8' },
);
if (hashRun.status !== 0) {
  console.error(
    `check-prebuilt-pin: cannot compute the input hash\n${hashRun.stderr}`,
  );
  process.exit(1);
}
const current = hashRun.stdout.trim();

const problems = [];
if (pin.inputHash !== current) {
  problems.push(
    `pin inputHash ${pin.inputHash || '(empty)'} does not match the current C++ inputs ${current}`,
  );
}
if (!pin.assets || Object.keys(pin.assets).length === 0) {
  problems.push('pin lists no prebuilt assets');
}

if (problems.length > 0) {
  console.error(
    'react-native-gpui will not publish with a stale prebuilt pin:',
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    'Run the prebuilt-binaries workflow (or force it) so the pin is updated, then publish.',
  );
  process.exit(1);
}
console.log(
  `check-prebuilt-pin: pin ${pin.version} matches inputHash ${current}`,
);
