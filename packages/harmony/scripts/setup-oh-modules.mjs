#!/usr/bin/env node

/**
 * Setup npm → oh_modules bridge for the HarmonyOS build.
 *
 * Why: ArkTS OhmUrl resolver cannot process .js files from npm packages
 * (relative imports like ./foo.js aren't valid OhmUrl paths). This script
 * creates "dist-types/" — a type-only copy of dist/ containing only .d.ts
 * files — and symlinks oh_modules to it. The ArkTS compiler sees types
 * but never encounters .js files, avoiding OhmUrl resolution failures.
 *
 * Run after `npm run build:server-deps` whenever workspace types change.
 * The script is idempotent — safe to run multiple times.
 *
 * Usage:
 *   node packages/harmony/scripts/setup-oh-modules.mjs
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, rmSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HARMONY_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(HARMONY_DIR, '../..');

// Workspace packages needed by the harmony entry
const WORKSPACE_PACKAGES = [
  { name: '@getpaseo/client', dir: 'client' },
  { name: '@getpaseo/protocol', dir: 'protocol' },
  { name: '@getpaseo/relay', dir: 'relay' },
  { name: '@getpaseo/highlight', dir: 'highlight' },
];

// npm registry packages imported by harmony code
const NPM_PACKAGES = ['zod', 'markdown-it', 'mnemonic-id'];

/**
 * Copy all .d.ts files from srcDir to destDir recursively.
 */
function copyDtsFiles(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = resolve(srcDir, entry.name);
    const destPath = resolve(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyDtsFiles(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      cpSync(srcPath, destPath);
    }
  }
}

/**
 * Create subpath symlinks so ArkTS can resolve imports like
 * `@getpaseo/client/internal/daemon-client-transport-types`.
 */
function createSubpathSymlinks(distDir, distTypesDir) {
  if (!existsSync(distTypesDir)) return;

  // Map of subpath → source file (relative to distDir)
  const subpathMap = {
    client: {
      'internal/daemon-client-transport-types': 'daemon-client-transport-types.d.ts',
    },
    protocol: {
      'messages': 'messages.d.ts',
      'client-capabilities': 'client-capabilities.d.ts',
      'agent-types': 'agent-types.d.ts',
      'daemon-endpoints': 'daemon-endpoints.d.ts',
      'terminal-subscription-key': 'terminal-subscription-key.d.ts',
      'binary-frames/index': 'binary-frames/index.d.ts',
      'browser-automation/rpc-schemas': 'browser-automation/rpc-schemas.d.ts',
    },
    relay: {
      'e2ee': 'e2ee.d.ts',
    },
  };

  for (const [pkgDir, subpaths] of Object.entries(subpathMap)) {
    for (const [subpath, source] of Object.entries(subpaths)) {
      const targetDir = resolve(distTypesDir, pkgDir, dirname(subpath));
      const targetFile = resolve(distTypesDir, pkgDir, `${subpath}.d.ts`);
      const sourceFile = resolve(distTypesDir, pkgDir, source);

      if (!existsSync(sourceFile)) continue;
      mkdirSync(targetDir, { recursive: true });
      if (existsSync(targetFile)) rmSync(targetFile, { force: true });
      symlinkSync(sourceFile, targetFile, 'file');
    }
  }
}

console.log('[setup-oh-modules] Building workspace dependencies (may take a while)...');
try {
  execSync('npm run build:server-deps', { cwd: REPO_ROOT, stdio: 'inherit', timeout: 120_000 });
} catch (err) {
  console.warn('[setup-oh-modules] Build had errors (some dist/ may be missing) — continuing.');
  // Don't exit — some packages may already have dist/ from a prior build.
}

// Step 1: Generate dist-types/ for each workspace package
console.log('[setup-oh-modules] Generating dist-types/ (type-only .d.ts copies)...');
for (const pkg of WORKSPACE_PACKAGES) {
  const distDir = resolve(REPO_ROOT, 'packages', pkg.dir, 'dist');
  const distTypesDir = resolve(REPO_ROOT, 'packages', pkg.dir, 'dist-types');

  if (!existsSync(distDir)) {
    console.warn(`  SKIP ${pkg.name}: dist/ not found (run build:server-deps first)`);
    continue;
  }

  // Clean and recreate
  if (existsSync(distTypesDir)) rmSync(distTypesDir, { recursive: true, force: true });
  mkdirSync(distTypesDir, { recursive: true });

  // Copy .d.ts files
  copyDtsFiles(distDir, distTypesDir);

  // Copy oh-package.json5 with paths adjusted for dist-types (no ./dist/ prefix)
  const ohPkgJson = resolve(REPO_ROOT, 'packages', pkg.dir, 'oh-package.json5');
  if (existsSync(ohPkgJson)) {
    const content = readFileSync(ohPkgJson, 'utf-8')
      .replace(/\.\/dist\//g, './');
    writeFileSync(resolve(distTypesDir, 'oh-package.json5'), content);
  }

  const count = execSync(`find ${distTypesDir} -name '*.d.ts' | wc -l`, { encoding: 'utf-8' }).trim();
  console.log(`  OK  ${pkg.name} → ${count} .d.ts files`);
}

// Step 2: Create subpath symlinks
console.log('[setup-oh-modules] Creating subpath symlinks...');
createSubpathSymlinks(
  resolve(REPO_ROOT, 'packages'),
  resolve(REPO_ROOT, 'packages')
);

// Step 3: Create oh_modules symlinks
console.log('[setup-oh-modules] Setting up oh_modules symlinks...');
const ohModulesDir = resolve(HARMONY_DIR, 'entry/oh_modules');
if (existsSync(ohModulesDir)) rmSync(ohModulesDir, { recursive: true, force: true });
mkdirSync(ohModulesDir, { recursive: true });

// Symlink workspace packages to dist-types/
const ohScopeDir = resolve(ohModulesDir, '@getpaseo');
mkdirSync(ohScopeDir, { recursive: true });
for (const pkg of WORKSPACE_PACKAGES) {
  const src = resolve(REPO_ROOT, 'packages', pkg.dir, 'dist-types');
  const dest = resolve(ohScopeDir, pkg.dir);
  if (existsSync(src)) {
    symlinkSync(src, dest, 'dir');
    console.log(`  OK  ${pkg.name} → dist-types/${pkg.dir}`);
  }
}

// Symlink npm registry packages from node_modules
const nodeModulesDir = resolve(REPO_ROOT, 'node_modules');
for (const pkgName of NPM_PACKAGES) {
  const src = resolve(nodeModulesDir, pkgName);
  const dest = resolve(ohModulesDir, pkgName);
  if (existsSync(src)) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    symlinkSync(src, dest, 'dir');
    console.log(`  OK  ${pkgName} → node_modules/${pkgName}`);
  } else {
    console.warn(`  SKIP ${pkgName}: not in node_modules`);
  }
}

console.log('[setup-oh-modules] Done. Ready for hvigorw assembleHap.');
