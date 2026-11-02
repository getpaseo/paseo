#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNodeModule, repoRoot as findRepoRoot } from './repo-root.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repoRoot = findRepoRoot(scriptDir);
const cppDir = path.join(packageDir, 'ReactGpui', 'rn-gpui-sys', 'cpp');
const reactNativeRoot =
  findNodeModule(packageDir, 'react-native') ??
  path.join(repoRoot, 'node_modules', 'react-native');
const reactCommonDir = path.join(reactNativeRoot, 'ReactCommon');
const reactCxxPlatformDir = path.join(packageDir, 'ReactCxxPlatform');
const overridesDir = path.join(packageDir, 'ReactCommonOverrides');

const [, , bridgeArg, rncoreArg, buildArg] = process.argv;
if (!bridgeArg || !rncoreArg) {
  console.error(
    'usage: check-standalone-cmake.mjs <cxxbridge-include-dir> <generated-rncore-dir> [build-dir]',
  );
  process.exit(2);
}
const bridgeDir = path.resolve(bridgeArg);
const rncoreDir = path.resolve(rncoreArg);
if (!existsSync(path.join(bridgeDir, 'rust', 'cxx.h'))) {
  console.error(`missing ${path.join(bridgeDir, 'rust', 'cxx.h')}`);
  process.exit(2);
}
const buildDir = path.resolve(
  buildArg ?? path.join(os.tmpdir(), 'rn-gpui-standalone-cmake'),
);
mkdirSync(buildDir, { recursive: true });

const cmake = args => {
  const result = spawnSync('cmake', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

cmake([
  '-S',
  cppDir,
  '-B',
  buildDir,
  '-DCMAKE_BUILD_TYPE=Debug',
  `-DRN_GPUI_PROJECT_ROOT=${repoRoot}`,
  `-DREACT_COMMON_DIR=${reactCommonDir}`,
  `-DREACT_CXX_PLATFORM_DIR=${reactCxxPlatformDir}`,
  `-DRN_GPUI_OVERRIDES_DIR=${overridesDir}`,
  `-DRN_GPUI_CXXBRIDGE_INCLUDE_DIR=${bridgeDir}`,
  `-DRN_GPUI_GENERATED_RNCORE_DIR=${rncoreDir}`,
]);
cmake(['--build', buildDir, '--target', 'rn_gpui_core', '--parallel']);
console.log(`rn_gpui_core built in ${buildDir}`);
