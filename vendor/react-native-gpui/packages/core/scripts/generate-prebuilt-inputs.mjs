#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNodeModule, repoRoot as findRepoRoot } from './repo-root.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const repoRoot = findRepoRoot(scriptDir);
const reactNativeDir =
  findNodeModule(packageDir, 'react-native') ??
  path.join(repoRoot, 'node_modules', 'react-native');
const rnGpuiSysDir = path.join(packageDir, 'ReactGpui', 'rn-gpui-sys');
const fbSpecCodegen = path.join(
  rnGpuiSysDir,
  'scripts',
  'generate-fbreactnativespec.cjs',
);

// Keep this in sync with the cxx entry in ReactGpui/Cargo.lock.
const CXX_VERSION = '1.0.202';

function fail(message) {
  console.error(`generate-prebuilt-inputs: ${message}`);
  process.exit(2);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(' ')} exited with ${result.status ?? result.signal}`,
    );
  }
  return result.stdout;
}

function lockedCxxVersion() {
  const lock = readFileSync(
    path.join(packageDir, 'ReactGpui', 'Cargo.lock'),
    'utf8',
  );
  const match = lock.match(/name = "cxx"\r?\nversion = "([^"]+)"/u);
  if (!match) fail('cxx is not in ReactGpui/Cargo.lock');
  if (match[1] !== CXX_VERSION) {
    fail(`Cargo.lock pins cxx ${match[1]}; update CXX_VERSION to match`);
  }
  return match[1];
}

function ensureCxxbridge(toolRoot) {
  const bin = path.join(
    toolRoot,
    'bin',
    process.platform === 'win32' ? 'cxxbridge.exe' : 'cxxbridge',
  );
  if (existsSync(bin)) return bin;
  mkdirSync(toolRoot, { recursive: true });
  console.error(
    `generate-prebuilt-inputs: installing cxxbridge-cmd ${CXX_VERSION}`,
  );
  run(
    'cargo',
    [
      'install',
      '--locked',
      '--version',
      CXX_VERSION,
      'cxxbridge-cmd',
      '--root',
      toolRoot,
    ],
    { stdio: 'inherit' },
  );
  if (!existsSync(bin)) fail(`cargo install did not produce ${bin}`);
  return bin;
}

const outDir = path.resolve(process.argv[2] ?? fail('usage: <out-dir>'));
lockedCxxVersion();

const toolRoot = path.join(os.tmpdir(), `rn-gpui-cxxbridge-${CXX_VERSION}`);
const cxxbridge = ensureCxxbridge(toolRoot);

const bridgeInclude = path.join(outDir, 'cxxbridge-include');
rmSync(bridgeInclude, { recursive: true, force: true });
mkdirSync(path.join(bridgeInclude, 'rust'), { recursive: true });
mkdirSync(path.join(bridgeInclude, 'rn-gpui-sys', 'src'), { recursive: true });
const cxxH = run(cxxbridge, ['--header']);
writeFile(path.join(bridgeInclude, 'rust', 'cxx.h'), cxxH);
const libRsH = run(cxxbridge, [
  path.join(rnGpuiSysDir, 'src', 'lib.rs'),
  '--header',
]);
writeFile(path.join(bridgeInclude, 'rn-gpui-sys', 'src', 'lib.rs.h'), libRsH);

const rncoreDir = path.join(outDir, 'fbreactnativespec');
rmSync(rncoreDir, { recursive: true, force: true });
run(process.execPath, [fbSpecCodegen, reactNativeDir, rncoreDir], {
  stdio: 'inherit',
});
if (!existsSync(path.join(rncoreDir, 'jni'))) {
  fail(`codegen produced no jni/ under ${rncoreDir}`);
}

console.error(`generate-prebuilt-inputs: bridge ${bridgeInclude}`);
console.error(`generate-prebuilt-inputs: rncore ${rncoreDir}`);
process.stdout.write(`${bridgeInclude}\n${rncoreDir}\n`);

function writeFile(file, content) {
  writeFileSync(file, content);
}
