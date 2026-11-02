#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const WORKFLOW_FILE = 'hermes-engine.yml';
const ARTIFACT_PREFIX = 'hermes-';
const RELEASE_PREFIX = '@react-native-gpui/hermes@';
const RELEASE_MARKER = '.release';
const MAX_REDIRECTS = 8;
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
/**
 * Where the staged binaries live. `RN_GPUI_HERMES_BIN_ROOT` is honoured by
 * CMake (`gpui/CMakeLists.txt`) and by `gpui/node-api-exports.test.js`, so the
 * downloader has to agree with them: writing to the package's own `bin/` while
 * the build looks somewhere else fails with "Hermes library not found" at
 * configure time.
 */
export function binRootFrom(env = process.env) {
  return env.RN_GPUI_HERMES_BIN_ROOT || path.join(packageRoot, 'bin');
}

const binRoot = binRootFrom();

const PLATFORMS = {
  'darwin-arm64': ['libhermesvm.dylib', 'hermesc'],
  'darwin-x64': ['libhermesvm.dylib', 'hermesc'],
  'linux-x64': ['libhermesvm.so', 'hermesc'],
  'linux-arm64': ['libhermesvm.so', 'hermesc'],
  'win32-x64': ['hermesvm.dll', 'hermesvm.lib', 'hermesc.exe'],
  'win32-arm64': ['hermesvm.dll', 'hermesvm.lib', 'hermesc.exe'],
};

function usage() {
  console.log(
    [
      'Usage: node scripts/fetch-binaries.mjs [options]',
      '',
      '  (no options)          download this platform from the pinned release',
      '  --run <run-id>        download a specific workflow run',
      '  --tag <release-tag>   download hermes-*.zip assets from a GitHub release',
      '  --from <zip|dir>      install a manually downloaded artifact',
      '  --platform <key>      limit to one of: ' +
        Object.keys(PLATFORMS).join(', '),
      '  --verify              report the binaries installed for this host',
      '  --verify --all        report every platform',
      '  --help                show this message',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const options = { mode: 'latest', platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.mode = 'help';
    } else if (arg === '--verify') {
      options.mode = 'verify';
    } else if (arg === '--run') {
      options.mode = 'run';
      options.runId = argv[++i];
    } else if (arg === '--tag') {
      options.mode = 'tag';
      options.tag = argv[++i];
    } else if (arg === '--from') {
      options.mode = 'from';
      options.from = argv[++i];
    } else if (arg === '--platform') {
      options.platform = argv[++i];
    } else if (arg === '--all') {
      options.all = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.platform && !PLATFORMS[options.platform])
    throw new Error(`Unknown platform: ${options.platform}`);
  return options;
}

export function selectedPlatforms(options) {
  if (options.platform) return [options.platform];
  if (options.all) return Object.keys(PLATFORMS);
  const host = `${process.platform}-${process.arch}`;
  if (!PLATFORMS[host])
    throw new Error(
      `No Hermes binaries are defined for this host (${host}); use --platform or --all.`,
    );
  return [host];
}

/// The release repository, read from this package's own manifest rather than
/// from the environment: a fork's PR, or a user's CI, runs with a
/// GITHUB_REPOSITORY that points at *their* repository, which has no hermes
/// release. Accepts the string form and `{ url }`, and strips the git+ prefix,
/// the GitHub URL and a trailing .git.
export function repositoryFromManifest(manifest, env = process.env) {
  if (env.RN_GPUI_HERMES_REPO) return env.RN_GPUI_HERMES_REPO;
  const repository = manifest?.repository;
  const url =
    typeof repository === 'string' ? repository : (repository?.url ?? '');
  const match = url.match(
    /^(?:git\+)?(?:https?:\/\/github\.com\/|git@github\.com:)?([^/]+\/[^/]+?)(?:\.git)?$/u,
  );
  if (!match) {
    throw new Error(
      `could not read the repository from package.json (repository: ${JSON.stringify(repository)})`,
    );
  }
  return match[1];
}

function platformDir(platform, root = binRoot) {
  return path.join(root, platform);
}

/// The tag or source recorded by the install that put the files there, or null
/// when the directory predates this marker.
export function recordedSource(platform, root = binRoot) {
  try {
    const text = fs.readFileSync(
      path.join(platformDir(platform, root), RELEASE_MARKER),
      'utf8',
    );
    return text.trim() || null;
  } catch {
    return null;
  }
}

export function writeRecordedSource(platform, source, root = binRoot) {
  const dir = platformDir(platform, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RELEASE_MARKER), `${source}\n`);
}

/**
 * Whether the default mode may replace what is in `bin/<platform>/`.
 *
 * A complete directory counts as installed only when its `.release` names the
 * tag being asked for: a version bump has to replace the old binaries, and a
 * directory installed before the marker existed is treated as stale. A source
 * that is not a release tag is a hand-installed build (`--from`, `--run`),
 * which must be kept.
 */
export function installedState(platform, tag, root = binRoot) {
  const missing = PLATFORMS[platform].filter(
    file => !fs.existsSync(path.join(root, platform, file)),
  );
  if (missing.length > 0) return { state: 'missing' };
  const source = recordedSource(platform, root);
  if (source === null) return { state: 'stale' };
  if (source === tag) return { state: 'current' };
  return source.startsWith(RELEASE_PREFIX)
    ? { state: 'stale' }
    : { state: 'foreign', source };
}

function verify(options) {
  let missing = 0;
  for (const platform of selectedPlatforms(options)) {
    const dir = path.join(binRoot, platform);
    const found = PLATFORMS[platform].filter(file =>
      fs.existsSync(path.join(dir, file)),
    );
    const state =
      found.length === PLATFORMS[platform].length
        ? 'ok'
        : found.length === 0
          ? 'missing'
          : `partial (${found.join(', ')})`;
    if (found.length !== PLATFORMS[platform].length) missing += 1;
    console.log(`${platform.padEnd(14)} ${state}`);
  }
  if (missing) {
    console.log(
      `\n${missing} platform(s) without binaries. Run the hermes-engine workflow and install the artifacts with --from, or use --run/--tag with gh installed.`,
    );
    process.exitCode = 1;
  }
  return missing === 0;
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    // Use the bsdtar that ships with Windows; the GNU tar from Git for Windows
    // (first on PATH in bash steps) cannot read zip files.
    const systemTar = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    );
    const tar = fs.existsSync(systemTar) ? systemTar : 'tar';
    execFileSync(tar, ['-xf', archive, '-C', destination], {
      stdio: 'inherit',
    });
    return;
  }
  execFileSync('unzip', ['-oq', archive, '-d', destination], {
    stdio: 'inherit',
  });
}

/**
 * Copies the platform trees found under `sourceRoot` into the package. Two
 * layouts are accepted: `bin/<platform>/` as written by the local build scripts
 * and the release zips, and `<platform>/` at the root of a `hermes-<platform>`
 * artifact, because actions/upload-artifact uploads `bin/` without its prefix.
 */
function installFrom(sourceRoot, platforms, source) {
  const wanted = new Set(platforms);
  const installed = [];
  const install = (from, platform) => {
    const to = platformDir(platform);
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    for (const file of fs.readdirSync(to)) {
      if (file === 'hermesc' || file === 'hermesc.exe')
        fs.chmodSync(path.join(to, file), 0o755);
    }
    installed.push(platform);
    wanted.delete(platform);
  };
  const visit = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (wanted.has(entry.name)) {
        install(child, entry.name);
      } else if (
        entry.name === 'bin' ||
        entry.name === 'artifacts' ||
        entry.name === 'download' ||
        entry.name.startsWith(ARTIFACT_PREFIX)
      ) {
        visit(child);
      }
    }
  };
  visit(sourceRoot);
  if (installed.length === 0)
    throw new Error(
      `No hermes-<platform> artifacts with <platform>/ or bin/<platform>/ under ${sourceRoot}`,
    );
  // Record where each platform came from, so the default mode can tell a stale
  // release apart from a build a developer installed on purpose.
  for (const platform of installed) writeRecordedSource(platform, source);
  console.log(`Installed: ${installed.join(', ')}`);
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { stdio: 'inherit', ...options });
}

function downloadFromRun(options) {
  let runId = options.runId;
  if (!runId) {
    runId = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        WORKFLOW_FILE,
        '--status',
        'success',
        '--limit',
        '1',
        '--json',
        'databaseId',
        '--jq',
        '.[0].databaseId',
      ],
      { encoding: 'utf8' },
    ).trim();
    if (!runId)
      throw new Error('No successful hermes-engine workflow run found');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-binaries-'));
  console.log(`Downloading hermes-engine run ${runId} into ${dir}`);
  gh(['run', 'download', runId, '--dir', dir]);
  installFrom(dir, selectedPlatforms(options), `run:${runId}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function downloadFromRelease(options) {
  if (!options.tag) throw new Error('--tag needs a release tag');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-binaries-'));
  console.log(`Downloading ${options.tag} assets into ${dir}`);
  gh([
    'release',
    'download',
    options.tag,
    '--dir',
    dir,
    '--pattern',
    `${ARTIFACT_PREFIX}${options.platform ?? '*'}.zip`,
    '--clobber',
  ]);
  for (const file of fs.readdirSync(dir))
    if (file.endsWith('.zip'))
      extractArchive(path.join(dir, file), path.join(dir, file.slice(0, -4)));
  installFrom(dir, selectedPlatforms(options), options.tag);
  fs.rmSync(dir, { recursive: true, force: true });
}

function offline() {
  return (
    process.env.RN_GPUI_PREBUILT_OFFLINE === '1' ||
    process.env.CARGO_NET_OFFLINE === 'true'
  );
}

/**
 * Follows redirects, streams the body to dest, and drops the authorization
 * header when a redirect leaves GitHub. Same behaviour as the prebuilt runtime
 * download, so a proxy or mirror that replays GitHub's redirects works here too.
 */
function download(url, dest, redirects = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS)
      return reject(new Error('too many redirects'));
    const parsed = new URL(url);
    const req = httpsRequest(
      parsed,
      { headers: { 'user-agent': 'react-native-gpui-hermes', ...headers } },
      res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          const host = new URL(next).hostname;
          const keep =
            host.endsWith('github.com') ||
            host.endsWith('githubusercontent.com');
          return resolve(
            download(next, dest, redirects + 1, keep ? headers : {}),
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Downloads the platform's zip from the release named after this package's own
 * version, so a fresh checkout can build without the hermes-engine workflow
 * having been run by hand.
 *
 * A platform is skipped only when its recorded `.release` names this tag; a
 * version bump therefore replaces the old binaries. A directory installed from
 * another source is a developer's own build and is left alone with one line.
 */
async function downloadFromPin(options) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const tag = `${RELEASE_PREFIX}${manifest.version}`;
  const repository = repositoryFromManifest(manifest);
  const wanted = selectedPlatforms(options);

  const stale = [];
  let kept = false;
  for (const platform of wanted) {
    const { state, source } = installedState(platform, tag);
    if (state === 'current') continue;
    if (state === 'foreign') {
      kept = true;
      console.log(
        `Hermes binaries for ${platform} were installed from ${source}; keeping them (delete bin/${platform} to use ${tag})`,
      );
      continue;
    }
    stale.push(platform);
  }
  if (stale.length === 0) {
    if (!kept)
      console.log(`Hermes binaries for this host are installed (${tag})`);
    return;
  }
  if (offline())
    throw new Error(
      `Hermes binaries are missing or stale (${stale.join(', ')}) and offline mode is on; install them with --from or clear RN_GPUI_PREBUILT_OFFLINE.`,
    );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-binaries-'));
  for (const platform of stale) {
    const file = `${ARTIFACT_PREFIX}${platform}.zip`;
    const archive = path.join(dir, file);
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${file}`;
    const headers = { accept: 'application/octet-stream' };
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    // github.com answers a missing asset with a 404 page, which unzip would
    // report as a corrupt archive; ask for the bytes like the release download.
    if (token) headers.authorization = `Bearer ${token}`;
    console.log(`Downloading ${url}`);
    await download(url, archive, 0, headers);
    extractArchive(archive, dir);
  }
  installFrom(dir, stale, tag);
  fs.rmSync(dir, { recursive: true, force: true });
}

function installFromPath(options) {
  if (!options.from)
    throw new Error('--from needs an artifact zip or directory');
  const source = path.resolve(options.from);
  if (!fs.existsSync(source)) throw new Error(`Not found: ${source}`);
  if (fs.statSync(source).isDirectory()) {
    installFrom(source, selectedPlatforms(options), `from:${source}`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-binaries-'));
  extractArchive(source, dir);
  installFrom(dir, selectedPlatforms(options), `from:${options.from}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') return usage();
  if (options.mode === 'verify') return verify(options);
  if (options.mode === 'from') return installFromPath(options);
  if (options.mode === 'run') return downloadFromRun(options);
  if (options.mode === 'tag') return downloadFromRelease(options);
  return downloadFromPin(options);
}

// Run as a CLI only when this file is the entry point, so the test can import
// the pure helpers without downloading anything. Both sides are resolved
// through the filesystem: a CMake build under /tmp is reached as /private/tmp,
// and comparing the raw strings made the script silently do nothing.
function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  const invoked = fs.realpathSync(path.resolve(process.argv[1]));
  return self === invoked;
}

if (isEntryPoint()) {
  try {
    await main();
  } catch (error) {
    console.error(`fetch-binaries: ${error.message}`);
    process.exitCode = 1;
  }
}
