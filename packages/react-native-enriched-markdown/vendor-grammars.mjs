#!/usr/bin/env node
// Restores the tree-sitter runtime, each supported grammar's minimal source set,
// and the default-language registry into packages/core/cpp/highlight/vendor/.
// The whole vendor/ tree (runtime, grammars, generated registry) is GITIGNORED
// and reproduced on demand from the pins in grammar-versions.json, so nothing
// generated lives in git. This one command is wired into the package `prepare`
// hook (run `yarn prepare` to self-heal the working tree; note this repo is Yarn 4
// (Berry), where a plain `yarn install` does NOT run the workspace `prepare`
// script) and into `prepack` (so the published npm tarball still ships the full
// set).
//
//   node vendor/vendor-grammars.mjs
//     Ensures the runtime (fetched from the pinned GitHub release tarball), every
//     grammar (copied from the grammar devDependencies), and the default registry
//     are present and up to date. Idempotent: .stamp fingerprints on the runtime
//     ref+sha and on the pinned grammar versions make repeated runs a no-op, so
//     re-running `prepare` never re-fetches or rewrites an up-to-date tree.
//
// Flags:
//   --only json,css   Restore just these grammars (dev/testing). Skips the
//                     default-registry refresh and the stamp, so it never
//                     clobbers the full vendored set.
//   --force           Re-fetch the runtime and rewrite every grammar regardless
//                     of the stamps.
//   --runtime-src <lib dir>  Use a local tree-sitter lib/ checkout instead of
//                     fetching the tarball (offline / maintainer override).
//   --from-npm        Download grammar sources from the npm registry instead of
//                     copying from devDependency node_modules. Used by the
//                     postinstall script in published packages where the grammar
//                     devDependencies are not installed.
//   --vendor-dir <dir>  Override the default vendor output directory.
//   --manifest <path>   Override the default grammar-versions.json path.
//
// Only parser.c, scanner.c (when present), tree_sitter/*.h, highlights.scm and
// LICENSE are copied per grammar; nothing else from the grammar packages ships.
// WASM is left out of the runtime by never defining TREE_SITTER_FEATURE_WASM at
// build time, so the full lib/src tree (including wasm_store.c and its no-op
// stubs) is vendored verbatim and only lib.c is compiled.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync, } from 'node:child_process';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
let vendorOut = path.join(repoRoot, 'packages/core/cpp/highlight/vendor');
let manifestPath = path.join(here, 'grammar-versions.json');

const LOG_PREFIX = '[react-native-enriched-markdown]';
const log = (message) => console.log(`${LOG_PREFIX} ${message}`);
const warn = (message) => console.warn(`${LOG_PREFIX} ${message}`);

// Grammar packages are devDependencies of react-native-enriched-markdown, so
// resolve them from that workspace regardless of hoisting.
const pkgRequire = createRequire(
  path.join(repoRoot, 'packages/react-native-enriched-markdown/package.json')
);

function parseArgs(argv) {
  const args = { only: null, runtimeSrc: null, force: false, fromNpm: false, vendorDir: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--runtime-src') args.runtimeSrc = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--from-npm') args.fromNpm = true;
    else if (argv[i] === '--vendor-dir') args.vendorDir = argv[++i];
    else if (argv[i] === '--manifest') args.manifest = argv[++i];
    // --grammars-only is accepted for backward compatibility; the single restore
    // flow already covers grammars, so it is a no-op.
    else if (argv[i] === '--grammars-only') continue;
  }
  return args;
}

function fail(message) {
  console.error(`${LOG_PREFIX} ${message}`);
  process.exit(1);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFile(from, to);
  }
}

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

// Copies lib/src + lib/include/tree_sitter/api.h from a tree-sitter `lib`
// checkout into the vendor tree. Shared by the tarball and --runtime-src paths.
function copyRuntimeFromLib(libDir) {
  const srcDir = path.join(libDir, 'src');
  const apiHeader = path.join(libDir, 'include/tree_sitter/api.h');
  if (!fs.existsSync(path.join(srcDir, 'lib.c')) || !fs.existsSync(apiHeader)) {
    fail(`runtime source at ${libDir} is missing src/lib.c or include/tree_sitter/api.h`);
  }
  const outSrc = path.join(vendorOut, 'tree-sitter/src');
  fs.rmSync(outSrc, { recursive: true, force: true });
  copyDir(srcDir, outSrc);
  copyFile(apiHeader, path.join(vendorOut, 'tree-sitter/include/tree_sitter/api.h'));
}

function runtimeTarballUrl(runtime) {
  return runtime.tarball ?? `https://github.com/tree-sitter/tree-sitter/archive/refs/tags/${runtime.ref}.tar.gz`;
}

// Downloads the pinned runtime tarball, verifies its sha256 against the manifest,
// extracts it to a temp dir with the system `tar`, and returns the `lib/` path.
// A sha mismatch is fatal and prints the computed digest to paste back into the
// manifest on a deliberate re-pin.
async function fetchRuntimeLib(runtime) {
  const url = runtimeTarballUrl(runtime);
  if (!runtime.sha256) {
    fail(`runtime.sha256 missing in grammar-versions.json; cannot verify ${url}`);
  }
  log(`fetching runtime ${runtime.ref} from ${url}`);
  let buf;
  try {
    const res = await fetch(url);
    if (!res.ok) fail(`runtime download failed: ${res.status} ${res.statusText} for ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    fail(`runtime download failed for ${url}: ${err.message}. Pass --runtime-src to vendor from a local checkout offline.`);
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== runtime.sha256) {
    fail(
      `runtime tarball sha256 mismatch for ${url}\n  expected ${runtime.sha256}\n  got      ${digest}\n` +
        'If this is a deliberate re-pin, update runtime.sha256 in grammar-versions.json to the "got" value.'
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-runtime-'));
  const tgz = path.join(tmp, 'runtime.tar.gz');
  fs.writeFileSync(tgz, buf);
  const untar = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' });
  if (untar.status !== 0) fail(`tar failed to extract ${tgz} (status ${untar.status})`);
  const top = fs
    .readdirSync(tmp, { withFileTypes: true })
    .find((e) => e.isDirectory() && e.name.startsWith('tree-sitter-'));
  if (!top) fail(`extracted runtime tarball has no tree-sitter-* directory in ${tmp}`);
  return { libDir: path.join(tmp, top.name, 'lib'), tmp };
}

// Fingerprint of the pinned runtime: ref + sha (+ 'local' when sourced from a
// checkout). A re-pin invalidates it; matching stamp + present lib.c is a no-op.
function runtimeStampKey(runtime, fromLocal) {
  return `${runtime.ref}|${runtime.sha256 ?? 'nosha'}|${fromLocal ? 'local' : 'tarball'}`;
}

async function ensureRuntime(manifest, args) {
  const runtime = manifest.runtime ?? {};
  const localLib = firstExisting([args.runtimeSrc, process.env.TREE_SITTER_SRC].filter(Boolean));
  const stampFile = path.join(vendorOut, 'tree-sitter/.stamp');
  const stampKey = runtimeStampKey(runtime, !!localLib);
  const present = fs.existsSync(path.join(vendorOut, 'tree-sitter/src/lib.c'));

  if (!args.force && present && readStamp(stampFile) === stampKey) {
    log('runtime already up to date; skipping.');
    return;
  }

  if (localLib) {
    copyRuntimeFromLib(localLib);
  } else {
    const { libDir, tmp } = await fetchRuntimeLib(runtime);
    try {
      copyRuntimeFromLib(libDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(stampFile, stampKey + '\n');
  log(`runtime -> ${path.relative(repoRoot, path.join(vendorOut, 'tree-sitter/src'))}`);
}

function packageRoot(pkgName) {
  try {
    return path.dirname(pkgRequire.resolve(`${pkgName}/package.json`));
  } catch {
    fail(`grammar package ${pkgName} not installed. Add it as a devDependency and run yarn install.`);
    return '';
  }
}

// Resolves a grammar's highlights.scm from its package (null if it ships none).
// A grammar with no highlights query cannot be compiled into the registry, so
// callers skip it. Kept separate so main() can pre-filter without side effects.
function grammarHighlights(spec, pkgRootOverride) {
  const pkgRoot = pkgRootOverride ?? packageRoot(spec.package);
  const base = spec.subPath ? path.join(pkgRoot, spec.subPath) : pkgRoot;
  return firstExisting([
    path.join(base, 'queries/highlights.scm'),
    path.join(pkgRoot, 'queries/highlights.scm'),
  ]);
}

// tree-sitter grammars that build on another grammar's queries usually say so
// with a leading `; inherits:` comment, which gen-registry.mjs reads to inline
// the parent's captures. Some packages (notably tree-sitter-typescript) instead
// list the base query in their package's `queries` array and ship a
// highlights.scm with no such comment, so a verbatim copy drops every inherited
// capture -- for TypeScript that means strings, comments, and all base
// JavaScript keywords/functions, leaving only the TS-only supplement colored.
// Materialize the manifest's `inherits` as that comment here so the existing
// gen-registry inlining restores full highlighting. Idempotent: parents already
// named by an upstream `; inherits:` line are merged, not duplicated.
const INHERITS_RE = /^[ \t]*;+[ \t]*inherits[ \t]*:[ \t]*([^\n]+)$/m;

function writeHighlights(srcFile, destFile, spec) {
  const raw = fs.readFileSync(srcFile, 'utf8');
  const existing = raw.match(INHERITS_RE);
  const parents = existing
    ? existing[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const parent of spec.inherits ?? []) {
    if (!parents.includes(parent)) parents.push(parent);
  }
  if (parents.length === 0) {
    copyFile(srcFile, destFile);
    return;
  }
  const body = raw.replace(INHERITS_RE, '').replace(/^\n+/, '');
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, `; inherits: ${parents.join(',')}\n${body}`);
}

function vendorGrammar(id, spec, pkgRootOverride) {
  const pkgRoot = pkgRootOverride ?? packageRoot(spec.package);
  const base = spec.subPath ? path.join(pkgRoot, spec.subPath) : pkgRoot;
  const srcDir = path.join(base, 'src');
  const outDir = path.join(vendorOut, 'grammars', id);

  const parser = path.join(srcDir, 'parser.c');
  if (!fs.existsSync(parser)) fail(`${id}: parser.c not found at ${parser}`);

  if (spec.scanner && !fs.existsSync(path.join(srcDir, 'scanner.c'))) {
    fail(`${id}: scanner:true but scanner.c missing at ${srcDir}`);
  }

  // Resolve highlights before writing anything so a highlights-less grammar
  // never leaves a partial output dir (main() filters these out up front).
  const highlights = grammarHighlights(spec, pkgRootOverride);
  if (!highlights) fail(`${id}: queries/highlights.scm not found under ${base} or ${pkgRoot}`);

  fs.rmSync(outDir, { recursive: true, force: true });

  // Copy every loose .c/.h in src/ (parser.c, scanner.c, plus siblings a scanner
  // text-includes such as html's tag.h or yaml's schema.*.c). Only parser.c and
  // scanner.c are compiled; the rest are include-only. node-types.json,
  // grammar.json and other non-source files are left behind.
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(c|h)$/.test(entry.name)) {
      copyFile(path.join(srcDir, entry.name), path.join(outDir, entry.name));
    }
  }

  const headerDir = path.join(srcDir, 'tree_sitter');
  if (fs.existsSync(headerDir)) copyDir(headerDir, path.join(outDir, 'tree_sitter'));

  writeHighlights(highlights, path.join(outDir, 'highlights.scm'), spec);

  const license = firstExisting([
    path.join(pkgRoot, 'LICENSE'),
    path.join(pkgRoot, 'LICENSE.md'),
    path.join(pkgRoot, 'LICENSE.txt'),
  ]);
  if (license) copyFile(license, path.join(outDir, 'LICENSE'));

  // Localize any header a source file includes from outside its own src/ dir.
  // tree-sitter-typescript's typescript and tsx grammars both text-include
  // "../../common/scanner.h", a header shared at the package root that the
  // per-grammar copy above (which only walks src/) leaves behind. Copy each into
  // the grammar dir under its basename and rewrite the escaping include to that
  // basename, so it resolves through the grammar's own quoted includes -- its
  // tree_sitter/parser.h is vendored alongside -- with no shared search path.
  for (const rel of spec.sharedSrc ?? []) {
    const from = path.join(srcDir, rel);
    if (!fs.existsSync(from)) fail(`${id}: sharedSrc '${rel}' not found at ${from}`);
    const base = path.basename(rel);
    copyFile(from, path.join(outDir, base));
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(c|h)$/.test(entry.name)) continue;
      const filePath = path.join(outDir, entry.name);
      const text = fs.readFileSync(filePath, 'utf8');
      const rewritten = text.split(`"${rel}"`).join(`"${base}"`);
      if (rewritten !== text) fs.writeFileSync(filePath, rewritten);
    }
  }

  log(`${id} -> ${path.relative(repoRoot, outDir)}`);
}

function regenerateDefaultRegistry(manifest) {
  const defaults = Object.entries(manifest.grammars)
    .filter(([, spec]) => spec.default)
    .map(([id]) => id);
  const outDir = path.join(vendorOut, 'generated');
  const result = spawnSync(
    process.execPath,
    [
      path.join(here, 'gen-registry.mjs'),
      '--vendor-dir',
      vendorOut,
      '--languages',
      defaults.join(','),
      '--out',
      outDir,
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) fail('gen-registry.mjs failed while refreshing the committed default set');
}

function requireSpec(manifest, id) {
  const spec = manifest.grammars[id];
  if (!spec) fail(`unknown grammar '${id}' (not in grammar-versions.json)`);
  return spec;
}

// Fingerprint of the pinned grammar set: manifest spec plus each grammar
// package's installed version, so a re-pin OR a node_modules change invalidates.
function grammarStampKey(manifest, ids) {
  const parts = ids.map((id) => {
    const spec = requireSpec(manifest, id);
    let version = 'missing';
    try {
      version = pkgRequire(`${spec.package}/package.json`).version;
    } catch {
      /* resolved lazily during copy; a miss just forces a rebuild */
    }
    return `${id}|${spec.package}@${version}|scanner:${!!spec.scanner}|sub:${spec.subPath ?? ''}|shared:${(spec.sharedSrc ?? []).join('+')}`;
  });
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function everyGrammarPresent(ids) {
  return ids.every((id) => fs.existsSync(path.join(vendorOut, 'grammars', id, 'parser.c')));
}

function readStamp(stampFile) {
  return fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null;
}

// Drops grammars whose package ships no highlights.scm (they cannot be compiled
// into any registry). A default-set grammar missing one is a hard error; others
// are skipped with a warning and any stale output removed.
function vendorableIds(manifest, ids) {
  const out = [];
  for (const id of ids) {
    const spec = requireSpec(manifest, id);
    if (grammarHighlights(spec)) {
      out.push(id);
    } else if (spec.default) {
      fail(`${id} is in the default set but its package ships no queries/highlights.scm`);
    } else {
      fs.rmSync(path.join(vendorOut, 'grammars', id), { recursive: true, force: true });
      warn(`${id}: package ships no highlights.scm; skipping (non-default, not compilable).`);
    }
  }
  return out;
}

function registryPresent() {
  return fs.existsSync(path.join(vendorOut, 'generated/generated_registry.cpp'));
}

// ---------------------------------------------------------------------------
// --from-npm: download grammar packages from the npm registry instead of
// copying from devDependency node_modules. Used by the postinstall script
// in published packages where the grammar devDependencies are not installed.
// ---------------------------------------------------------------------------

function npmTarballUrl(pkg, version) {
  if (pkg.startsWith('@')) {
    const bare = pkg.split('/')[1];
    return `https://registry.npmjs.org/${pkg}/-/${bare}-${version}.tgz`;
  }
  return `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
}

async function downloadNpmTarballs(grammars, ids) {
  const byPkg = new Map();
  for (const id of ids) {
    const spec = grammars[id];
    const key = `${spec.package}@${spec.version}`;
    if (!byPkg.has(key)) byPkg.set(key, { spec, ids: [] });
    byPkg.get(key).ids.push(id);
  }

  const extracted = new Map();
  await Promise.all(
    [...byPkg.entries()].map(async ([key, { spec }]) => {
      const url = npmTarballUrl(spec.package, spec.version);
      log(`downloading ${key} ...`);
      let buf;
      try {
        const res = await fetch(url);
        if (!res.ok) fail(`${key}: HTTP ${res.status} for ${url}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        fail(`${key}: download failed: ${err.message}`);
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-npm-'));
      const tgz = path.join(tmp, 'pkg.tar.gz');
      fs.writeFileSync(tgz, buf);
      const untar = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'pipe' });
      if (untar.status !== 0) fail(`tar extract failed for ${key}`);
      let root = path.join(tmp, 'package');
      if (!fs.existsSync(root)) {
        const fallback = fs.readdirSync(tmp, { withFileTypes: true })
          .find((e) => e.isDirectory());
        if (fallback) root = path.join(tmp, fallback.name);
        else fail(`extracted npm tarball for ${key} has no package/ directory`);
      }
      extracted.set(key, { root, tmp });
    })
  );
  return extracted;
}

function npmGrammarStampKey(manifest, ids) {
  const parts = ids.map((id) => {
    const spec = manifest.grammars[id];
    return `${id}|${spec.package}@${spec.version}|scanner:${!!spec.scanner}|sub:${spec.subPath ?? ''}|shared:${(spec.sharedSrc ?? []).join('+')}`;
  });
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.vendorDir) vendorOut = path.resolve(args.vendorDir);
  if (args.manifest) manifestPath = path.resolve(args.manifest);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const requested = args.only ?? Object.keys(manifest.grammars);

  // Runtime: fetched from the pinned tarball (gitignored, idempotent via stamp).
  await ensureRuntime(manifest, args);

  if (args.fromNpm) {
    // Consumer mode: download grammar sources from the npm registry.
    // The pre-built registry is already shipped in the tarball, so no
    // registry regeneration is needed.
    const ids = requested;
    const stampFile = path.join(vendorOut, 'grammars', '.stamp');
    const stampKey = args.only ? null : npmGrammarStampKey(manifest, ids);

    if (!args.force && stampKey && everyGrammarPresent(ids) && readStamp(stampFile) === stampKey) {
      log('grammar sources already up to date; skipping.');
    } else {
      const tarballs = await downloadNpmTarballs(manifest.grammars, ids);
      try {
        for (const id of ids) {
          const spec = requireSpec(manifest, id);
          const key = `${spec.package}@${spec.version}`;
          const { root } = tarballs.get(key);
          vendorGrammar(id, spec, root);
        }
      } finally {
        for (const { tmp } of tarballs.values()) {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      if (stampKey) {
        fs.mkdirSync(path.dirname(stampFile), { recursive: true });
        fs.writeFileSync(stampFile, stampKey + '\n');
      }
      log('grammar sources ready.');
    }
  } else {
    // Monorepo mode: copy grammar sources from devDependency node_modules.
    const ids = vendorableIds(manifest, requested);
    const stampFile = path.join(vendorOut, 'grammars', '.stamp');
    const stampKey = args.only ? null : grammarStampKey(manifest, ids);

    let grammarsRebuilt = false;
    if (!args.force && stampKey && everyGrammarPresent(ids) && readStamp(stampFile) === stampKey) {
      log('grammar sources already up to date; skipping.');
    } else {
      for (const id of ids) vendorGrammar(id, requireSpec(manifest, id));
      if (stampKey) fs.writeFileSync(stampFile, stampKey + '\n');
      grammarsRebuilt = true;
      log('grammar sources ready.');
    }

    // Default registry: regenerated from the vendored grammars. A partial --only
    // run must not touch it (the default set may not all be vendored). Otherwise
    // refresh it whenever the grammars changed or it is missing.
    if (!args.only && (args.force || grammarsRebuilt || !registryPresent())) {
      regenerateDefaultRegistry(manifest);
    }
  }

  log('done.');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
