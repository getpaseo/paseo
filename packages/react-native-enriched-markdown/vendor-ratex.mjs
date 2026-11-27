#!/usr/bin/env node
// Restores RaTeX's prebuilt static XCFramework, its four core Swift sources, and
// the KaTeX fonts into packages/react-native-enriched-markdown/ios/vendor/.
//
// This replaces React Native's `spm_dependency` wiring for iOS math. spm_dependency
// checks out RaTeX from SPM and builds/signs its Swift wrapper at app-build time,
// which produced arch-specific swiftmodules (#527) and duplicate signed-XCFramework
// signatures that collide during archive assembly (#491). Vendoring the already-built,
// already-signed XCFramework once removes that whole class of SPM/CocoaPods interop
// bugs and drops the requirement to `use_frameworks! :linkage => :dynamic`.
//
// The vendor tree is GITIGNORED and reproduced on demand from the pins in
// ratex-version.json, mirroring the tree-sitter runtime restore in vendor-grammars.mjs.
// Wired into the package `prepare` hook (self-heal the working tree) and `prepack`
// (bake the full set into the published npm tarball). Idempotent: a `.stamp`
// fingerprint on the pinned tag + both asset sha256s makes repeat runs a no-op.
//
//   node vendor/vendor-ratex.mjs            Ensure the vendored set is present/current.
//   node vendor/vendor-ratex.mjs --force    Re-fetch and rewrite regardless of the stamp.
//
// Offline: point a manifest url at a local file path (absolute) and it is read from
// disk instead of fetched; the sha256 is still verified.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
let manifestPath = path.join(here, 'ratex-version.json');
let outDir = path.join(repoRoot, 'packages/react-native-enriched-markdown/ios/vendor');

const LOG_PREFIX = '[react-native-enriched-markdown]';
const log = (m) => console.log(`${LOG_PREFIX} ${m}`);
const fail = (m) => { console.error(`${LOG_PREFIX} ${m}`); process.exit(1); };

function parseArgs(argv) {
  const args = { force: false, manifest: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  return args;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Downloads a url to a Buffer, resilient to the two failure modes that turn a
// routine install into #745: transient GitHub/CDN blips, and being behind a proxy.
// Node's global fetch is undici, which ignores http_proxy/https_proxy unless
// NODE_USE_ENV_PROXY is set, so on a proxied machine the source tarball can time out
// even though curl and the package manager both work. Retry fetch a few times, then
// fall back to curl, which honors the proxy env and retries itself. The caller still
// verifies the sha256, so a truncated or tampered body is caught either way.
async function download(url, label) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      log(`${label} fetch attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await sleep(500 * i);
    }
  }
  log(`${label} falling back to curl (honors http_proxy/https_proxy) for ${url}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratex-dl-'));
  try {
    const dest = path.join(tmp, 'asset');
    const res = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.error && res.error.code === 'ENOENT') {
      fail(`${label} download failed for ${url}: fetch failed and curl is not installed`);
    }
    if (res.status !== 0) fail(`${label} download failed for ${url} (curl exit ${res.status})`);
    return fs.readFileSync(dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Reads a manifest asset from a local path when the url points at an existing file
// (offline), otherwise downloads it. The sha256 is verified either way; a mismatch is
// fatal and prints the computed digest to paste back into ratex-version.json on a re-pin.
async function fetchAndVerify(url, sha256, label) {
  if (!sha256) fail(`${label}.sha256 missing in ratex-version.json; cannot verify ${url}`);
  let buf;
  if (path.isAbsolute(url) && fs.existsSync(url)) {
    log(`reading ${label} from local ${url}`);
    buf = fs.readFileSync(url);
  } else {
    log(`fetching ${label} from ${url}`);
    buf = await download(url, label);
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== sha256) {
    fail(
      `${label} sha256 mismatch for ${url}\n  expected ${sha256}\n  got      ${digest}\n` +
        'If this is a deliberate re-pin, update the sha256 in vendor/ratex-version.json to the "got" value.'
    );
  }
  return buf;
}

function extractTo(buf, ext, args, tmp) {
  const archive = path.join(tmp, `ratex${ext}`);
  fs.writeFileSync(archive, buf);
  const tool = ext === '.zip' ? 'unzip' : 'tar';
  const argv = ext === '.zip' ? ['-q', '-o', archive, ...args] : ['-xzf', archive, ...args];
  const res = spawnSync(tool, argv, { stdio: 'inherit' });
  if (res.status !== 0) fail(`${tool} failed to extract ${archive} (status ${res.status})`);
}

function stampKey(m) {
  return `${m.tag}|${m.xcframework.sha256}|${m.source.sha256}`;
}

function present(m, dir) {
  if (!fs.existsSync(path.join(dir, 'RaTeX.xcframework/Info.plist'))) return false;
  for (const rel of m.source.swiftSources) {
    if (!fs.existsSync(path.join(dir, path.basename(rel)))) return false;
  }
  return fs.existsSync(path.join(dir, 'Fonts'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.manifest) manifestPath = path.resolve(args.manifest);
  if (args.output) outDir = path.resolve(args.output);

  const stampFile = path.join(outDir, '.stamp');

  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const key = stampKey(m);

  if (!args.force && present(m, outDir) &&
      (fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null) === key) {
    log('RaTeX vendor tree already up to date; skipping.');
    return;
  }

  // Assemble the whole tree in a sibling staging dir and swap it into place only
  // after every asset (XCFramework, the four Swift sources, the fonts, the stamp)
  // has landed. A failure partway -- most commonly the source tarball fetch after
  // the XCFramework already extracted -- must never leave a half-written tree: the
  // podspec would read the lone XCFramework as "math ready" and compile the RaTeX
  // bridge against Swift sources that are not there (#745). Staging plus a final
  // swap makes a failed vendor indistinguishable from an absent one, which the
  // podspec's default-on path degrades cleanly. The staging dir is a sibling of
  // outDir so it shares its filesystem and the closing rename never crosses
  // devices (EXDEV), and a --force that fails leaves the previous good tree intact.
  const staging = outDir + '.staging';
  // fail() exits the process directly rather than throwing, so cleanup cannot live
  // in a catch alone; an exit hook removes the staging dir on every failure path.
  // After a successful swap the dir no longer exists, so this becomes a no-op.
  process.on('exit', () => {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const xcframeworkDir = path.join(staging, 'RaTeX.xcframework');
  const fontsOut = path.join(staging, 'Fonts');

  // 1. Prebuilt static XCFramework (device + simulator[arm64,x86_64] + macOS slices).
  const xcBuf = await fetchAndVerify(m.xcframework.url, m.xcframework.sha256, 'xcframework');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratex-xcf-'));
    try {
      extractTo(xcBuf, '.zip', ['-d', staging], tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!fs.existsSync(xcframeworkDir)) fail(`extracted zip has no RaTeX.xcframework in ${staging}`);
  }

  // 2. Core Swift sources + KaTeX fonts + LICENSE from the pinned source tag.
  const srcBuf = await fetchAndVerify(m.source.url, m.source.sha256, 'source');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratex-src-'));
    try {
      extractTo(srcBuf, '.tgz', ['-C', tmp], tmp);
      const root = path.join(tmp, m.source.prefix);
      if (!fs.existsSync(root)) fail(`source tarball has no ${m.source.prefix}/ directory`);

      for (const rel of m.source.swiftSources) {
        const from = path.join(root, rel);
        if (!fs.existsSync(from)) fail(`source tarball missing ${rel}`);
        copyFile(from, path.join(staging, path.basename(rel)));
      }

      const fontsSrc = path.join(root, m.source.fontsDir);
      if (!fs.existsSync(fontsSrc)) fail(`source tarball missing ${m.source.fontsDir}`);
      let n = 0;
      for (const f of fs.readdirSync(fontsSrc)) {
        if (f.endsWith('.ttf')) { copyFile(path.join(fontsSrc, f), path.join(fontsOut, f)); n++; }
      }
      if (n === 0) fail(`no .ttf fonts found under ${m.source.fontsDir}`);

      const licenseFrom = path.join(root, m.source.license);
      if (fs.existsSync(licenseFrom)) copyFile(licenseFrom, path.join(staging, 'LICENSE'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  fs.writeFileSync(path.join(staging, '.stamp'), key + '\n');

  // Publish by swapping directories, never deleting the previous tree before the new
  // one is in place. rm-then-rename has a window where a failed rename leaves the
  // vendor dir empty and wipes a previously-good tree. Instead: move any existing tree
  // aside (a rename, atomic on one filesystem), then move the staged tree in; if that
  // second move fails, restore the one set aside so a failed install can never empty
  // the vendor dir. Only once the new tree is live is the old one removed -- a failure
  // there is harmless, leaving a .backup the next run clears. A previously-good tree
  // therefore survives any single failure in this sequence.
  const backup = outDir + '.backup';
  fs.rmSync(backup, { recursive: true, force: true });
  const hadPrevious = fs.existsSync(outDir);
  if (hadPrevious) fs.renameSync(outDir, backup);
  try {
    fs.renameSync(staging, outDir);
  } catch (err) {
    if (hadPrevious) fs.renameSync(backup, outDir);
    throw err;
  }
  fs.rmSync(backup, { recursive: true, force: true });

  log(`RaTeX ${m.tag} -> ${outDir}`);
  log('done.');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
