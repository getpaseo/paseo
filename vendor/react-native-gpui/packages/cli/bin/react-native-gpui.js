#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  collectNodeAddons,
  createLibrary,
  initDesktop,
  initProject,
  runDesktop,
} from '../src/commands.js';
import { autolink } from '../src/autolink.js';
const requestedCommand = process.argv[2];
const command = requestedCommand === 'run-desktop' ? 'run' : requestedCommand;
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const hasFlag = name => process.argv.includes(name);
const projectRoot = path.resolve(option('--project-root') ?? process.cwd());
const desktopRoot = path.join(projectRoot, 'desktop');
const run = (bin, args) =>
  execFileSync(bin, args, { cwd: projectRoot, stdio: 'inherit' });

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    'usage: npx react-native run-desktop [--project-root path] [--port 8082] [--release] [--features feature,...] [--no-launch]',
  );
  process.exit(0);
}

if (command === 'init-desktop') {
  initDesktop({ projectRoot, skipInstall: hasFlag('--skip-install') });
  process.exit(0);
}

if (command === 'create-library') {
  createLibrary({
    libraryName: process.argv[3],
    type: option('--type') ?? 'rust',
    destination: option('--directory'),
    moduleName: option('--module-name'),
    packageName: option('--package-name'),
  });
  process.exit(0);
}

if (command === 'init') {
  const appName = process.argv[3];
  if (!appName || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(appName)) {
    console.error('usage: react-native-gpui init <AppName> [--directory path]');
    process.exit(2);
  }
  const destination = path.resolve(option('--directory') ?? appName);
  const initArgs = process.argv.slice(4);
  for (let index = 0; index < initArgs.length; index += 1) {
    if (
      initArgs[index] === '--directory' ||
      initArgs[index] === '--project-root'
    ) {
      initArgs.splice(index, 2);
      index -= 1;
    }
  }
  initProject({ appName, destination, initArgs });
  process.exit(0);
}

if (
  !['autolink', 'bundle', 'collect-node-addons', 'prebuilt', 'run'].includes(
    command,
  )
) {
  console.error(
    'usage: react-native-gpui <init|init-desktop|create-library|autolink|bundle|collect-node-addons|package-desktop|prebuilt|run> [options]',
  );
  process.exit(2);
}

if (command === 'collect-node-addons') {
  collectNodeAddons({
    bundle: option('--bundle'),
    out: option('--out'),
    platform: option('--platform'),
  });
  process.exit(0);
}

if (command === 'run') {
  await runDesktop({
    projectRoot,
    entryFile: option('--entry-file'),
    bundle: option('--bundle'),
    config: option('--config'),
    release: hasFlag('--release'),
    features: option('--features'),
    noLaunch: hasFlag('--no-launch'),
    port: option('--port'),
    host: option('--host'),
  });
  process.exit(0);
}

if (command === 'bundle') {
  const entryFile = option('--entry-file') ?? 'index.js';
  const bundlePath = path.resolve(
    option('--bundle') ?? path.join(desktopRoot, 'build/index.bundle'),
  );
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  const bundleArgs = [
    'react-native',
    'bundle',
    '--platform',
    'desktop',
    '--entry-file',
    entryFile,
    '--bundle-output',
    bundlePath,
    '--assets-dest',
    path.join(path.dirname(bundlePath), 'assets'),
    '--dev',
    'false',
  ];
  const metroConfig =
    option('--config') ?? path.join(desktopRoot, 'metro.config.js');
  if (fs.existsSync(metroConfig)) bundleArgs.push('--config', metroConfig);
  process.exit(0);
}

if (command === 'autolink') {
  autolink({ projectRoot, configFile: option('--config-json') });
  process.exit(0);
}

if (command === 'prebuilt') {
  const appRequire = createRequire(path.join(projectRoot, 'package.json'));
  let gpuiPackageJson;
  try {
    gpuiPackageJson = appRequire.resolve(
      '@react-native-gpui/core/package.json',
    );
  } catch {
    console.error(
      '@react-native-gpui/core is not installed in this project; run `npm install @react-native-gpui/core`.',
    );
    process.exit(1);
  }
  const script = path.join(
    path.dirname(gpuiPackageJson),
    'scripts',
    'prebuilt-binaries.mjs',
  );
  const subcommand = process.argv[3];
  const allowed = ['fetch', 'path', 'verify', 'clean'];
  if (!allowed.includes(subcommand)) {
    console.error(
      `usage: react-native-gpui prebuilt <${allowed.join('|')}> [--triple <triple>] [dir]`,
    );
    process.exit(1);
  }
  const forwarded = process.argv.slice(3);
  const result = spawnSync(process.execPath, [script, ...forwarded], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
