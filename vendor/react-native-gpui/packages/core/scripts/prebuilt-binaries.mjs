#!/usr/bin/env node
// Fetches, verifies and caches the prebuilt C++ runtime for react-native-gpui.
//
// Usage:
//   node scripts/prebuilt-binaries.mjs ensure [--triple <rust-triple>]
//       Print the cached runtime dir, downloading it first when needed.
//       Exit 2 when the pin file has no asset for the platform.
//   node scripts/prebuilt-binaries.mjs fetch [--triple <rust-triple>]
//       Same as ensure (the host triple by default).
//   node scripts/prebuilt-binaries.mjs path [--triple <rust-triple>]
//       Print the cache dir for the platform (does not download).
//   node scripts/prebuilt-binaries.mjs verify <dir>
//       Check every files[].sha256 in <dir>/manifest.json.
//   node scripts/prebuilt-binaries.mjs clean
//       Remove the cache for this package version.
//   node scripts/prebuilt-binaries.mjs pin --version <v> --input-hash <h> --tag <t>
//       --repo <owner/name> --sums <SHA256SUMS.txt> --out <pin.json>
//       Write the pin file from a release's SHA256SUMS.txt (used by CI).
//
// stdout carries only the result dir (or the verify result); diagnostics go to
// stderr. Environment:
//   RN_GPUI_PREBUILT_CACHE       cache root (default: the OS cache dir)
//   RN_GPUI_PREBUILT_OFFLINE=1   or CARGO_NET_OFFLINE=true: cache only, no network
//   GITHUB_TOKEN / GH_TOKEN      optional, sent with release downloads
//
// The pin file (packages/core/prebuilt-binaries.json) names the
// release and per-platform assets: { version, inputHash, repo, tag, assets:
// { "<platform>": { file, sha256, size } } }. An empty assets map means no
// prebuilt is published yet.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { copyFile as copyFileCb } from 'node:fs';

function copyFile(src, dest) {
  return new Promise((resolve, reject) =>
    copyFileCb(src, dest, err => (err ? reject(err) : resolve())),
  );
}

/**
 * The tar to extract an archive with. On Windows, use the bsdtar that ships
 * with the OS: a bash step puts Git-for-Windows' GNU tar first on PATH, and GNU
 * tar reads a `D:\...` argument as a remote host spec, failing with
 * "Cannot connect to D: resolve failed". Same reason `fetch-binaries.mjs`
 * prefers it for the Hermes zips.
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'tar.exe',
  );
  return existsSync(systemTar) ? systemTar : 'tar';
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const pinPath = path.join(packageDir, 'prebuilt-binaries.json');

const TRIPLE_PLATFORMS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
};
const MAX_REDIRECTS = 8;

function die(message, status = 1) {
  process.stderr.write(`prebuilt-binaries: ${message}\n`);
  process.exit(status);
}

function log(message) {
  process.stderr.write(`prebuilt-binaries: ${message}\n`);
}

function readPin() {
  return JSON.parse(readFileSync(pinPath, 'utf8'));
}

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
  die(`unsupported host ${process.platform}-${process.arch}`);
}

function platformFor(triple) {
  const platform = TRIPLE_PLATFORMS[triple];
  if (!platform) die(`no prebuilt platform for triple ${triple}`);
  return platform;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--triple') args.triple = argv[++i];
    else if (arg.startsWith('--triple=')) args.triple = arg.slice(9);
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[++i];
    } else args._.push(arg);
  }
  return args;
}

function cacheRoot() {
  if (process.env.RN_GPUI_PREBUILT_CACHE) {
    return path.resolve(process.env.RN_GPUI_PREBUILT_CACHE);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    );
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
}

function cacheDir(version, platform) {
  if (process.env.RN_GPUI_PREBUILT_CACHE) {
    return path.join(cacheRoot(), version, platform);
  }
  return path.join(
    cacheRoot(),
    'react-native-gpui',
    'prebuilt',
    version,
    platform,
  );
}

function offline() {
  return (
    process.env.RN_GPUI_PREBUILT_OFFLINE === '1' ||
    process.env.CARGO_NET_OFFLINE === 'true'
  );
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function isComplete(dir) {
  return existsSync(path.join(dir, 'manifest.json'));
}

// Follows redirects, sends the token only to GitHub hosts, and streams the body
// to dest while counting bytes.
function download(url, dest, redirects = 0, headers = {}) {
  if (url.startsWith('file:')) {
    return copyFile(fileURLToPath(url), dest);
  }
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS)
      return reject(new Error('too many redirects'));
    const parsed = new URL(url);
    const send = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const reqHeaders = {
      'user-agent': 'react-native-gpui-prebuilt',
      ...headers,
    };
    const req = send(parsed, { headers: reqHeaders }, res => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        // Drop the auth header when leaving GitHub, as curl does.
        const keep =
          new URL(next).hostname.endsWith('github.com') ||
          new URL(next).hostname.endsWith('githubusercontent.com');
        const nextHeaders = keep ? headers : {};
        return resolve(download(next, dest, redirects + 1, nextHeaders));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function releaseAuthHeaders() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = { accept: 'application/octet-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// RN_GPUI_PREBUILT_BASE_URL replaces the GitHub release base (file:// or
// http:// mirrors, used for testing and offline mirrors).
function assetUrl(pin, asset) {
  const base = process.env.RN_GPUI_PREBUILT_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/${asset.file}`;
  return `https://github.com/${pin.repo}/releases/download/${encodeURIComponent(
    pin.tag,
  )}/${asset.file}`;
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0) log(`waiting for another download (${lockPath})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      // A lock left by a dead process is removed after 10 minutes.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 600_000)
          unlinkSync(lockPath);
      } catch {}
    }
  }
  throw new Error(`timed out waiting for lock ${lockPath}`);
}

async function ensureDir(triple, { allowNetwork = true } = {}) {
  const pin = readPin();
  const platform = platformFor(triple);
  const asset = pin.assets?.[platform];
  if (!asset) {
    die(
      `no prebuilt asset for ${platform} in ${path.relative(packageDir, pinPath)} (version ${pin.version}); build from source or publish one`,
      2,
    );
  }
  const dir = cacheDir(pin.version, platform);
  if (isComplete(dir)) {
    return dir;
  }
  if (!allowNetwork || offline()) {
    die(
      `prebuilt ${platform} is not cached at ${dir} and offline mode is on`,
      3,
    );
  }

  const parent = path.dirname(dir);
  mkdirSync(parent, { recursive: true });
  const lockPath = `${dir}.lock`;
  acquireLock(lockPath);
  let temp;
  try {
    // Another process may have finished while we waited for the lock.
    if (isComplete(dir)) return dir;

    temp = path.join(
      parent,
      `.${platform}-${process.pid}-${Date.now()}.tar.gz`,
    );
    const url = assetUrl(pin, asset);
    log(`downloading ${asset.file} (${asset.size} bytes)`);
    await download(url, temp, 0, releaseAuthHeaders());

    const size = statSync(temp).size;
    if (size !== asset.size) {
      throw new Error(
        `size mismatch for ${asset.file}: expected ${asset.size}, got ${size}`,
      );
    }
    const digest = await sha256File(temp);
    if (digest !== asset.sha256) {
      throw new Error(
        `sha256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}`,
      );
    }

    const stage = path.join(parent, `.${platform}-${process.pid}-stage`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    const tar = spawnSync(
      tarCommand(),
      ['-xzf', temp, '-C', stage, '--strip-components=1'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    if (tar.status !== 0) {
      throw new Error(
        `tar failed: ${tar.stderr?.toString().trim() ?? tar.error}`,
      );
    }
    if (!isComplete(stage)) {
      throw new Error('archive has no manifest.json at its top level');
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(stage, dir);
    return dir;
  } finally {
    if (temp) rmSync(temp, { force: true });
    rmSync(lockPath, { force: true });
  }
}

async function verifyDir(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json in ${dir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) {
      failures.push(`missing ${rel}`);
      continue;
    }
    const digest = await sha256File(file);
    if (digest !== expected) failures.push(`sha256 mismatch ${rel}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    count: Object.keys(manifest.files ?? {}).length,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const triple = args.triple ?? hostTriple();

  switch (command) {
    case 'ensure':
    case 'fetch': {
      const dir = await ensureDir(triple);
      process.stdout.write(`${dir}\n`);
      return;
    }
    case 'path': {
      const pin = readPin();
      process.stdout.write(`${cacheDir(pin.version, platformFor(triple))}\n`);
      return;
    }
    case 'verify': {
      const dir = args._[0];
      if (!dir) die('verify needs a <dir>', 1);
      const result = await verifyDir(path.resolve(dir));
      if (!result.ok) {
        for (const failure of result.failures) log(failure);
        die(`verification failed (${result.failures.length} problem(s))`, 1);
      }
      process.stdout.write(`${path.resolve(dir)}\n`);
      log(`verified ${result.count} files`);
      return;
    }
    case 'clean': {
      const pin = readPin();
      const root = process.env.RN_GPUI_PREBUILT_CACHE
        ? path.join(cacheRoot(), pin.version)
        : path.join(cacheRoot(), 'react-native-gpui', 'prebuilt', pin.version);
      rmSync(root, { recursive: true, force: true });
      log(`removed ${root}`);
      return;
    }
    case 'pin': {
      // `--sums` and `--assets` are the same file: the CI workflow calls it
      // `--assets` while the usage line above says `--sums`. Accept both so the
      // published pin can be written by the command the workflow runs.
      const sums = args.sums ?? args.assets;
      const { version, inputHash, tag, repo, out } = args;
      for (const [k, v] of Object.entries({
        version,
        inputHash,
        tag,
        repo,
        sums,
        out,
      })) {
        if (!v)
          die(
            `pin needs --${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
            2,
          );
      }
      const sumsDir = path.dirname(path.resolve(sums));
      const assets = {};
      let reactNative = null;
      for (const rawLine of readFileSync(sums, 'utf8').split('\n')) {
        // A sums file written on Windows (PowerShell's `Set-Content`, or a
        // checkout with `core.autocrlf`) has CRLF endings, and the stray
        // carriage return stops the `$`-anchored pattern below from matching.
        const line = rawLine.trim();
        if (!line) continue;
        // The sums file also lists `prebuilt-binaries-<platform>-pdb.tar.gz`.
        // The alternation and the anchoring keep that from being read as a
        // platform named `win32-x64-pdb`.
        const match = line.match(
          /^([0-9a-f]{64})\s+\*?prebuilt-binaries-([a-z0-9]+-[a-z0-9_]+)\.tar\.gz$/u,
        );
        if (!match) continue;
        const [, sha256, platform] = match;
        const file = `prebuilt-binaries-${platform}.tar.gz`;
        // Only platforms this package knows are published.
        const knownPlatform = Object.keys(TRIPLE_PLATFORMS).some(
          t => TRIPLE_PLATFORMS[t] === platform,
        );
        if (!knownPlatform) continue;
        const archive = path.join(sumsDir, file);
        // The archive has one top-level <platform>/ dir; read its manifest.json
        // directly so the same call works with GNU and BSD tar.
        const manifest = JSON.parse(
          execFileSync(
            tarCommand(),
            ['-xzOf', archive, `${platform}/manifest.json`],
            {
              encoding: 'utf8',
              // The manifest lists every file (about 18k entries), above the default buffer.
              maxBuffer: 256 * 1024 * 1024,
            },
          ),
        );
        if (manifest.inputHash !== inputHash) {
          die(
            `${file} was built from input hash ${manifest.inputHash}, not ${inputHash}`,
            1,
          );
        }
        reactNative ??= manifest.reactNative;
        // Keyed by platform ("win32-x64"), not triple ("x86_64-pc-windows-msvc"):
        // that is the documented shape at the top of this file and what
        // `ensureDir` looks up (`pin.assets?.[platform]`). Keying by triple here
        // meant a written pin could never be read back.
        assets[platform] = {
          file,
          sha256,
          size: statSync(archive).size,
        };
      }
      if (Object.keys(assets).length === 0)
        die('no prebuilt archives in SHA256SUMS', 1);
      const pin = { version, reactNative, inputHash, repo, tag, assets };
      writeFileSync(path.resolve(out), `${JSON.stringify(pin, null, 2)}\n`);
      log(`wrote ${out} with ${Object.keys(assets).length} asset(s)`);
      return;
    }
    default:
      die(
        'usage: prebuilt-binaries.mjs <ensure|fetch|path|verify|clean|pin> [--triple <triple>] [dir]',
        1,
      );
  }
}

main().catch(error => {
  die(error?.message ?? String(error), 1);
});
