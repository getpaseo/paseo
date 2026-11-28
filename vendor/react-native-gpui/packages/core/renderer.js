// Which renderer an app runs and which React Native tree everything builds
// against. `renderer` and `jsThread` come from `desktop/desktop.json`
// (`desktop.<os>.json` on top), overridden by `RN_GPUI_RENDERER` and
// `RN_GPUI_JS_THREAD`. Fabric builds against the installed `react-native`;
// Loom builds against that package with Loom's overrides applied, produced by
// Loom's own `materialize` from a pinned source archive.
//
// Metro, autolink and the Rust build all go through `resolveRenderer`, so one
// answer selects the JavaScript, the C++ headers and the C++ sources.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RENDERERS = ['fabric', 'loom'];
const JS_THREADS = ['background', 'main'];
const PIN_PATH = path.join(__dirname, 'ReactGpui', 'loom-pin.json');

const CONFIG_FILES = {
  darwin: 'macos',
  win32: 'windows',
};

/**
 * The tar that extracts an archive. On Windows it is the one that ships with
 * the OS: a bash session puts Git's GNU tar first on PATH, and GNU tar reads a
 * `C:\...` argument as a remote host ("Cannot connect to C: resolve failed").
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'tar.exe',
  );
  return fs.existsSync(systemTar) ? systemTar : 'tar';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

/** `{ renderer, jsThread }` for an app, validated. */
function rendererConfig(
  projectRoot,
  { env = process.env, platform = process.platform } = {},
) {
  const desktopDir = path.join(projectRoot, 'desktop');
  const os_ = CONFIG_FILES[platform] ?? platform;
  const files = [
    readJson(path.join(desktopDir, 'desktop.json')),
    readJson(path.join(desktopDir, `desktop.${os_}.json`)),
  ];
  let renderer;
  let jsThread;
  for (const file of files) {
    if (file && file.renderer !== undefined) renderer = file.renderer;
    if (file && file.jsThread !== undefined) jsThread = file.jsThread;
  }
  const overridden = Boolean(env.RN_GPUI_RENDERER);
  renderer = env.RN_GPUI_RENDERER || renderer || 'fabric';
  jsThread = env.RN_GPUI_JS_THREAD || jsThread;
  if (!RENDERERS.includes(renderer)) {
    throw new Error(
      `renderer must be one of ${RENDERERS.map(name => `"${name}"`).join(', ')}, got ${JSON.stringify(renderer)}`,
    );
  }
  if (jsThread !== undefined && !JS_THREADS.includes(jsThread)) {
    throw new Error(
      `jsThread must be one of ${JS_THREADS.map(name => `"${name}"`).join(', ')}, got ${JSON.stringify(jsThread)}`,
    );
  }
  if (renderer !== 'loom' && jsThread !== undefined) {
    // A file's jsThread belongs to the renderer it was written for, so
    // switching to Fabric for one run needs no edit to the file.
    if (!overridden || env.RN_GPUI_JS_THREAD) {
      throw new Error('jsThread is only available with "renderer": "loom"');
    }
  }
  return {
    renderer,
    jsThread: renderer === 'loom' ? (jsThread ?? 'background') : undefined,
  };
}

/** The shared per-user cache the native dependency downloads also use. */
function cacheRoot(env = process.env) {
  const set = name => (env[name] ? env[name] : undefined);
  if (set('RN_GPUI_NATIVE_DEPS_CACHE')) {
    return path.resolve(set('RN_GPUI_NATIVE_DEPS_CACHE'));
  }
  if (set('RN_GPUI_PREBUILT_CACHE')) {
    return path.join(
      path.resolve(set('RN_GPUI_PREBUILT_CACHE')),
      'native-deps',
    );
  }
  const home = os.homedir();
  let base;
  if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Caches');
  } else if (process.platform === 'win32') {
    base = set('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
  } else {
    const xdg = set('XDG_CACHE_HOME');
    base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
  }
  return path.join(base, 'react-native-gpui', 'native-deps');
}

function loomPin() {
  return JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Runs `body` holding an exclusive directory lock; a dead owner's lock is taken over. */
async function withLock(lockDir, body) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = NaN;
      try {
        owner = Number(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'));
      } catch {}
      if (Number.isInteger(owner) && owner > 0) {
        let alive = true;
        try {
          process.kill(owner, 0);
        } catch (killError) {
          alive = killError.code === 'EPERM';
        }
        if (!alive) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() - started > 10 * 60 * 1000) {
        throw new Error(`${lockDir} is held; remove it if no build is running`);
      }
      await delay(200);
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects === 0)
            return reject(new Error(`too many redirects: ${url}`));
          resolve(
            download(
              new URL(response.headers.location, url).toString(),
              file,
              redirects - 1,
            ),
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`GET ${url} returned ${status}`));
        }
        const out = fs.createWriteStream(file);
        response.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

const sha256 = file =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The `react-native-loom` package directory: `RN_GPUI_LOOM_DIR` when set,
 * otherwise the pinned commit's archive, downloaded once into the cache and
 * checked against the pinned digest.
 */
async function loomPackageDir(env = process.env) {
  if (env.RN_GPUI_LOOM_DIR) {
    const dir = path.resolve(env.RN_GPUI_LOOM_DIR);
    if (!fs.existsSync(path.join(dir, 'bin', 'loom.js'))) {
      throw new Error(
        `RN_GPUI_LOOM_DIR must name a react-native-loom package (no bin/loom.js in ${dir})`,
      );
    }
    return dir;
  }
  const pin = loomPin();
  const id = pin.commit.slice(0, 12);
  const root = path.join(cacheRoot(env), 'loom');
  const finalDir = path.join(root, `loom-${id}`);
  const packageDir = path.join(finalDir, pin.packagePath);
  if (fs.existsSync(path.join(packageDir, 'bin', 'loom.js'))) return packageDir;

  const archive = path.join(root, `loom-${id}.tar.gz`);
  await withLock(path.join(root, `loom-${id}.lock`), async () => {
    if (fs.existsSync(path.join(packageDir, 'bin', 'loom.js'))) return;
    if (!fs.existsSync(archive) || sha256(archive) !== pin.sha256) {
      const part = `${archive}.part`;
      await download(pin.archiveUrl, part);
      const actual = sha256(part);
      if (actual !== pin.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(
          `${pin.archiveUrl} has sha256 ${actual}, expected ${pin.sha256}`,
        );
      }
      fs.renameSync(part, archive);
    }
    const scratch = `${finalDir}.tmp`;
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    execFileSync(tarCommand(), [
      '-xzf',
      archive,
      '-C',
      scratch,
      '--strip-components=1',
    ]);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(scratch, finalDir);
  });
  return packageDir;
}

function installedReactNative(projectRoot) {
  const manifest = require.resolve('react-native/package.json', {
    paths: [projectRoot],
  });
  const dir = path.dirname(fs.realpathSync(manifest));
  return {
    dir,
    version: JSON.parse(fs.readFileSync(manifest, 'utf8')).version,
  };
}

/** Runs `loom materialize` for the app's `react-native` into the cache. */
async function materializedTree(projectRoot, env = process.env) {
  const pristine = installedReactNative(projectRoot);
  const packageDir = await loomPackageDir(env);
  const loomVersion = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  ).version;
  const key = crypto
    .createHash('sha256')
    .update(`${packageDir}\0${pristine.dir}`)
    .digest('hex')
    .slice(0, 12);
  const out = path.join(
    cacheRoot(env),
    'loom',
    'trees',
    `${pristine.version}-${key}`,
    'react-native',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [path.join(packageDir, 'bin', 'loom.js'), 'materialize', '--out', out],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    throw new Error(
      `loom materialize failed:\n${error.stderr || error.stdout || error.message}`,
    );
  }
  return {
    reactNativeDir: out,
    pristineReactNativeDir: pristine.dir,
    loomPackageDir: packageDir,
    loomVersion,
  };
}

/**
 * Where an app's React Native comes from. Spawns itself for the Loom case,
 * because a download cannot finish inside a synchronous Metro config.
 */
function resolveRenderer(projectRoot, options = {}) {
  const config = rendererConfig(projectRoot, options);
  if (config.renderer === 'fabric') {
    const { dir } = installedReactNative(projectRoot);
    return { ...config, reactNativeDir: dir, pristineReactNativeDir: dir };
  }
  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, 'renderer.js'), 'tree', projectRoot],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return { ...config, ...JSON.parse(output.trim().split('\n').pop()) };
}

module.exports = {
  RENDERERS,
  JS_THREADS,
  rendererConfig,
  resolveRenderer,
  materializedTree,
  loomPackageDir,
  cacheRoot,
  loomPin,
};

if (require.main === module) {
  const [command, projectRoot] = process.argv.slice(2);
  if (command !== 'tree' || !projectRoot) {
    console.error('usage: renderer.js tree <project root>');
    process.exit(2);
  }
  materializedTree(path.resolve(projectRoot)).then(
    tree => console.log(JSON.stringify(tree)),
    error => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
