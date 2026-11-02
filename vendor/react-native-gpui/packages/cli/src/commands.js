import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { autolink, npxArgs, npxCommand, npxShell } from './autolink.js';
import { desktopOs, loadDesktopConfig, targetsFor } from './desktop-config.js';
import {
  CARGO_PACKAGER_VERSION,
  runtimeLibraries,
  targetProfileDir,
  toPackagerConfig,
} from './package-desktop.js';
import {
  cargoBuildRecording,
  cargoTargetDirectory,
  pruneTarget,
  targetGcEnabled,
  targetGcMaxAgeDays,
} from './target-gc.js';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(cliDir, '../templates');

/**
 * The app links the system xkbcommon and xcb libraries, and a missing one only
 * surfaces at the end of a long build as a linker error, so check up front.
 * A non-system pkg-config first on PATH (Linuxbrew, Nix) cannot see the system
 * packages. Pure so it can be unit tested: `runPkgConfig`
 * returns true, false, or 'missing-pkg-config'; `systemPkgConfigPath` returns
 * the system pkg-config search path, or null when it cannot be determined.
 *
 * The message stays distribution-neutral: it names the pkg-config module and
 * gives one install command per common package manager, and the path hint uses
 * whatever this machine's system pkg-config reports rather than a hard-coded
 * x86_64 Debian path.
 */
export function linuxBuildDependencyProblem(
  platform,
  runPkgConfig,
  systemPkgConfigPath = () => null,
) {
  if (platform !== 'linux') return null;
  // The libraries the app links on Linux (GPUI's keyboard handling over X11).
  const modules = [
    {
      pc: 'xkbcommon',
      packages: {
        'Debian/Ubuntu': 'libxkbcommon-dev',
        Fedora: 'libxkbcommon-devel',
        Arch: 'libxkbcommon',
      },
    },
    {
      pc: 'xkbcommon-x11',
      packages: {
        'Debian/Ubuntu': 'libxkbcommon-x11-dev',
        Fedora: 'libxkbcommon-x11-devel',
        Arch: 'libxkbcommon-x11',
      },
    },
    {
      pc: 'xcb',
      packages: {
        'Debian/Ubuntu': 'libxcb1-dev',
        Fedora: 'libxcb-devel',
        Arch: 'libxcb',
      },
    },
  ];
  const installExamples = packages =>
    Object.entries(packages)
      .map(([distribution, name]) => {
        const manager =
          distribution === 'Fedora'
            ? 'dnf'
            : distribution === 'Arch'
              ? 'pacman'
              : 'apt';
        const command =
          manager === 'pacman'
            ? `sudo pacman -S ${name}`
            : `sudo ${manager} install ${name}`;
        return `${distribution}: ${command}`;
      })
      .join(', ');
  for (const { pc, packages } of modules) {
    const result = runPkgConfig(pc);
    if (result === 'missing-pkg-config') {
      return (
        'pkg-config is required to build the desktop app on Linux. ' +
        "Install your distribution's pkg-config package " +
        '(Debian/Ubuntu: `sudo apt install pkg-config`, ' +
        'Fedora: `sudo dnf install pkgconf-pkg-config`, ' +
        'Arch: `sudo pacman -S pkgconf`), then re-run.'
      );
    }
    if (!result) {
      const systemPath = systemPkgConfigPath();
      const hint = systemPath
        ? `set PKG_CONFIG_PATH=${systemPath} and re-run.`
        : 'point PKG_CONFIG_PATH at your system pkgconfig directories and re-run.';
      return (
        `Linux build dependency ${pc} was not found. ` +
        `Install your distribution's development package for it ` +
        `(${installExamples(packages)}). ` +
        `If pkg-config cannot see the system packages (Linuxbrew or Nix ` +
        `pkg-config first on PATH does this), ${hint}`
      );
    }
  }
  return null;
}

/**
 * The system pkg-config search path, for the preflight hint. Uses
 * `/usr/bin/pkg-config` explicitly: a Linuxbrew or Nix `pkg-config` first on
 * PATH is exactly the situation the hint is about, and it reports its own
 * prefix, not the system one. Returns null when the binary is missing or the
 * query fails.
 */
function readSystemPkgConfigPath() {
  const pkgConfig = '/usr/bin/pkg-config';
  if (!fs.existsSync(pkgConfig)) return null;
  try {
    const output = execFileSync(
      pkgConfig,
      ['--variable', 'pc_path', 'pkg-config'],
      { encoding: 'utf8' },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

const run = (bin, args, options = {}) =>
  execFileSync(bin, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: 'inherit',
    env: options.env ?? process.env,
    shell: options.shell ?? false,
  });

function loadEngineBundle(projectRoot) {
  const appRequire = createRequire(path.join(projectRoot, 'package.json'));
  let platformPackageJson;
  try {
    platformPackageJson = appRequire.resolve(
      '@react-native-gpui/core/package.json',
    );
  } catch {
    return null;
  }
  const { activeJsEngineBundle } = appRequire(
    path.join(path.dirname(platformPackageJson), 'js-engine.js'),
  );
  return activeJsEngineBundle(projectRoot);
}

function copyFontAssets(projectRoot, bundlePath, config) {
  const destination = path.join(
    path.dirname(bundlePath),
    'assets',
    'assets',
    'fonts',
  );
  fs.rmSync(destination, { recursive: true, force: true });
  const sources = [];
  const appFonts = path.join(projectRoot, 'desktop/assets/fonts');
  if (fs.existsSync(appFonts)) sources.push({ root: appFonts, prefix: 'app' });
  for (const [name, dependency] of Object.entries(config.dependencies ?? {})) {
    const root =
      dependency.root ?? path.join(projectRoot, 'node_modules', name);
    for (const assets of dependency.assets ?? []) {
      sources.push({
        root: path.resolve(root, assets),
        prefix: name.replaceAll('/', '-'),
      });
    }
  }
  let copied = 0;
  const copyDirectory = (sourceRoot, directory, prefix) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        copyDirectory(sourceRoot, source, prefix);
      } else if (/\.(?:ttf|otf)$/iu.test(entry.name)) {
        const relative = path.relative(sourceRoot, source);
        const target = path.join(destination, prefix, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        copied += 1;
      }
    }
  };
  for (const source of sources)
    copyDirectory(source.root, source.root, source.prefix);
  console.log(`Prepared ${copied} desktop font asset(s) in ${destination}`);
}

function cargoConfigSetsTargetDir(projectRoot) {
  let directory = path.resolve(projectRoot);
  while (true) {
    for (const fileName of ['config.toml', 'config']) {
      const configPath = path.join(directory, '.cargo', fileName);
      if (!fs.existsSync(configPath)) continue;
      const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/u);
      let inBuildTable = false;
      for (const line of lines) {
        const table = line.match(/^\s*\[([^\]]+)\]/u);
        if (table) {
          inBuildTable = table[1].trim() === 'build';
        } else if (inBuildTable && /^\s*target-dir\s*=/u.test(line)) {
          return true;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * The project the Metro on `host:port` serves: its root, `null` for a Metro
 * that does not say (older versions), or `undefined` when none answers.
 */
export async function metroProjectRoot(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/status`, {
      signal: AbortSignal.timeout(1000),
    });
    if (
      !response.ok ||
      !(await response.text()).includes('packager-status:running')
    )
      return undefined;
    return response.headers.get('x-react-native-project-root');
  } catch {
    return undefined;
  }
}

const samePath = (a, b) => {
  const real = target => {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  return real(a) === real(b);
};

/**
 * The terminal Metro opens in: `--terminal`, then `$REACT_TERMINAL` (the
 * variable React Native's own `run-ios`/`run-android` read), then the
 * platform's default.
 */
export function metroTerminal(
  terminal,
  {
    platform = process.platform,
    env = process.env,
    exists = command => {
      try {
        execFileSync('which', [command], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  } = {},
) {
  const requested = terminal ?? env.REACT_TERMINAL;
  if (requested) return requested;
  if (platform === 'darwin') {
    if (env.TERM_PROGRAM === 'iTerm.app') return 'iTerm';
    return 'Terminal';
  }
  if (platform === 'win32') return 'cmd.exe';
  return [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'kitty',
    'alacritty',
    'xterm',
  ].find(exists);
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Opens Metro in a terminal window of its own, where its keys (`r`, `d`, `j`)
 * work, the way `run-ios` and `run-android` do. Returns false when no window
 * could be opened.
 */
function startMetroInTerminal({ projectRoot, desktopRoot, args, terminal }) {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  let cli;
  try {
    // `cli.js` is not in react-native's `exports`; `package.json` is.
    cli = path.join(
      path.dirname(require.resolve('react-native/package.json')),
      'cli.js',
    );
  } catch {
    return false;
  }
  if (!fs.existsSync(cli)) return false;
  const scriptDir = path.join(desktopRoot, 'build');
  fs.mkdirSync(scriptDir, { recursive: true });
  try {
    if (process.platform === 'win32') {
      const script = path.join(scriptDir, 'metro.bat');
      const quoted = [process.execPath, cli, ...args].map(arg => `"${arg}"`);
      fs.writeFileSync(
        script,
        `@echo off\r\ntitle Metro\r\ncd /d "${projectRoot}"\r\n${quoted.join(' ')}\r\npause\r\n`,
      );
      // A detached child on Windows gets a console window of its own.
      spawn('cmd.exe', ['/c', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
      return true;
    }
    const script = path.join(
      scriptDir,
      process.platform === 'darwin' ? 'metro.command' : 'metro.sh',
    );
    fs.writeFileSync(
      script,
      [
        '#!/bin/sh',
        `cd ${shellQuote(projectRoot)} || exit 1`,
        `exec ${[process.execPath, cli, ...args].map(shellQuote).join(' ')}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.chmodSync(script, 0o755);
    if (process.platform === 'darwin') {
      execFileSync('open', ['-a', terminal, script], { stdio: 'ignore' });
      return true;
    }
    // gnome-terminal takes the command after `--`; the others after `-e`.
    const terminalArgs = /gnome-terminal$/u.test(terminal)
      ? ['--', script]
      : ['-e', script];
    const child = spawn(terminal, terminalArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The previous behaviour: Metro in the background, logging to a file. */
function startMetroInBackground({ projectRoot, desktopRoot, args }) {
  const logPath = path.join(desktopRoot, 'build/metro.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const server = spawn(
    npxCommand,
    npxArgs(['react-native', ...args, '--no-interactive']),
    {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: npxShell,
    },
  );
  fs.closeSync(logFd);
  server.unref();
  const state = { error: undefined, server, logPath };
  server.once('error', error => {
    state.error = error;
  });
  return state;
}

async function ensureMetro({
  projectRoot,
  desktopRoot,
  host,
  port,
  config,
  packager = true,
  packagerLog = false,
  terminal,
}) {
  const runningFor = await metroProjectRoot(host, port);
  if (runningFor !== undefined) {
    if (runningFor !== null && !samePath(runningFor, projectRoot)) {
      throw new Error(
        `Metro at http://${host}:${port} is serving another project (${runningFor}). ` +
          `Stop it, or run on another port with --port.`,
      );
    }
    console.log(`Reusing Metro at http://${host}:${port}`);
    return;
  }
  if (!packager) {
    console.log(
      `Metro is not running at http://${host}:${port}; start it with npx react-native start --port ${port}.`,
    );
    return;
  }

  const args = ['start', '--host', host, '--port', String(port)];
  if (config) args.push('--config', config);
  const interactive = process.stdin.isTTY && !process.env.CI;
  const window =
    !packagerLog && interactive ? metroTerminal(terminal) : undefined;
  let background;
  if (
    window &&
    startMetroInTerminal({ projectRoot, desktopRoot, args, terminal: window })
  ) {
    console.log(`Starting Metro in a new ${window} window`);
  } else {
    background = startMetroInBackground({ projectRoot, desktopRoot, args });
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await metroProjectRoot(host, port)) !== undefined) {
      console.log(
        background
          ? `Started Metro at http://${host}:${port} (log: ${background.logPath})`
          : `Started Metro at http://${host}:${port}`,
      );
      return;
    }
    if (background?.error) throw background.error;
    if (background && background.server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    background
      ? `Metro did not start at http://${host}:${port}. Check ${background.logPath} or run npx react-native start --port ${port}.`
      : `Metro did not start at http://${host}:${port}. Check the Metro window or run npx react-native start --port ${port}.`,
  );
}

export async function runDesktop({
  projectRoot = process.cwd(),
  entryFile,
  bundle,
  config,
  release = false,
  port = 8081,
  host = 'localhost',
  packager = true,
  packagerLog = false,
  terminal,
  features,
  noLaunch = false,
  packaging = false,
}) {
  projectRoot = path.resolve(projectRoot);
  const dependencyProblem = linuxBuildDependencyProblem(
    process.platform,
    pc => {
      try {
        execFileSync('pkg-config', ['--exists', pc], { stdio: 'ignore' });
        return true;
      } catch (error) {
        return error?.code === 'ENOENT' ? 'missing-pkg-config' : false;
      }
    },
    readSystemPkgConfigPath,
  );
  if (dependencyProblem) throw new Error(dependencyProblem);
  const desktopRoot = path.join(projectRoot, 'desktop');
  entryFile ??=
    ['index.js', 'index.ts', 'index.tsx'].find(file =>
      fs.existsSync(path.join(projectRoot, file)),
    ) ?? 'index.js';
  const bundlePath = path.resolve(
    projectRoot,
    bundle ?? path.join(desktopRoot, 'build/index.bundle'),
  );
  const metroConfig = path.resolve(
    projectRoot,
    config ?? path.join(desktopRoot, 'metro.config.js'),
  );

  // Autolink first: the manifest it writes tells the bundle path which engine is
  // active, and therefore which Metro transform and shipping format to use.
  const rnConfig = autolink({ projectRoot });
  const engineBundle = loadEngineBundle(projectRoot);

  // What the runtime loads: the plain Metro bundle, or the engine's compiled
  // format (`.hbc` bytecode, for example).
  let runtimeBundlePath = bundlePath;

  if (release) {
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
    if (fs.existsSync(metroConfig)) bundleArgs.push('--config', metroConfig);
    run(npxCommand, npxArgs(bundleArgs), { cwd: projectRoot, shell: npxShell });

    if (engineBundle && typeof engineBundle.compile === 'function') {
      const extension =
        typeof engineBundle.bundleExtension === 'string'
          ? engineBundle.bundleExtension
          : '.js';
      const compiledPath = `${bundlePath.replace(/\.[^./\\]+$/u, '')}${extension}`;
      const compiled = engineBundle.compile({
        input: bundlePath,
        output: compiledPath,
        dev: false,
      });
      runtimeBundlePath = path.resolve(
        projectRoot,
        compiled?.output ?? compiledPath,
      );
    }
  } else {
    const numericPort = Number(port);
    if (
      !Number.isInteger(numericPort) ||
      numericPort < 1 ||
      numericPort > 65535
    ) {
      throw new Error(`--port must be an integer between 1 and 65535`);
    }
    await ensureMetro({
      projectRoot,
      desktopRoot,
      host,
      port: numericPort,
      config: fs.existsSync(metroConfig) ? metroConfig : undefined,
      packager,
      packagerLog,
      terminal,
    });
  }
  copyFontAssets(projectRoot, bundlePath, rnConfig);

  const appCargoManifest = path.join(desktopRoot, 'Cargo.toml');
  if (!fs.existsSync(appCargoManifest)) {
    throw new Error(`missing desktop Cargo manifest: ${appCargoManifest}`);
  }
  const cargoArgs = [noLaunch ? 'build' : 'run'];
  if (release) cargoArgs.push('--release');
  const cargoFeatures = (features ?? '')
    .split(',')
    .map(feature => feature.trim())
    .filter(Boolean);
  if (cargoFeatures.some(feature => !/^[A-Za-z0-9_/-]+$/u.test(feature))) {
    throw new Error(
      '--features must be a comma-separated list of Cargo features',
    );
  }
  if (cargoFeatures.length > 0)
    cargoArgs.push('--features', cargoFeatures.join(','));
  cargoArgs.push('--manifest-path', appCargoManifest);
  const cargoEnv = {
    ...process.env,
    RN_GPUI_BUNDLE: runtimeBundlePath,
    RN_GPUI_ASSETS_DIR: path.join(path.dirname(bundlePath), 'assets', 'assets'),
    RN_GPUI_SOURCE_URL: entryFile.replace(/\.[^.]+$/u, ''),
    RN_GPUI_DEV_HOST: host,
    RN_GPUI_DEV_PORT: String(port),
    RN_GPUI_AUTOLINK_MANIFEST: path.join(desktopRoot, 'autolink/autolink.json'),
    RN_GPUI_AUTOLINK_CMAKE: path.join(desktopRoot, 'autolink/autolink.cmake'),
  };
  // An unbundled run has no Info.plist to name its icon, so the app is told
  // where it is and sets its Dock icon itself.
  if (!packaging) cargoEnv.RN_GPUI_APP_ICON = appIconPath(projectRoot);
  // `package-desktop` sets this: the binary is about to be installed elsewhere,
  // so `build.rs` emits only relative rpaths. A plain release build keeps the
  // absolute ones, because it is run from this tree.
  if (packaging) cargoEnv.RN_GPUI_PACKAGING = '1';
  if (
    process.env.CARGO_TARGET_DIR === undefined &&
    !cargoConfigSetsTargetDir(projectRoot)
  ) {
    cargoEnv.CARGO_TARGET_DIR = path.join(desktopRoot, 'build/target');
  }
  if (targetGcEnabled()) {
    // Cargo never cleans a target directory, so every build first drops the
    // units no build has used for a week, then builds while recording what it
    // used. The build is separate from the launch so its JSON messages are not
    // mixed with the app's own output; `cargo run` then finds it all fresh.
    const targetDir = cargoTargetDirectory(appCargoManifest, {
      cwd: projectRoot,
      env: cargoEnv,
    });
    if (targetDir) pruneTarget(targetDir, { maxAgeDays: targetGcMaxAgeDays() });
    await cargoBuildRecording(['build', ...cargoArgs.slice(1)], {
      cwd: projectRoot,
      env: cargoEnv,
      targetDir,
    });
    if (!noLaunch) {
      run('cargo', cargoArgs, { cwd: projectRoot, env: cargoEnv });
    }
  } else {
    run('cargo', cargoArgs, {
      cwd: projectRoot,
      env: cargoEnv,
    });
  }

  // The file the runtime was told to load: the engine's compiled output in a
  // release build, the Metro bundle otherwise. `package-desktop` stages it.
  return { runtimeBundlePath, bundlePath };
}

const appPackageName = (projectRoot, packageJson) =>
  `react-native-gpui-${(packageJson.name ?? path.basename(projectRoot))
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, '-')}`;

function snapshotTree(root, track, rememberDirectory, existingDirectories) {
  if (!fs.existsSync(root)) {
    rememberDirectory(root);
    return;
  }
  existingDirectories.add(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      snapshotTree(target, track, rememberDirectory, existingDirectories);
    } else track(target);
  }
}

function removeNewFiles(root, snapshots, existingDirectories) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory())
      removeNewFiles(target, snapshots, existingDirectories);
    else if (!snapshots.has(target)) {
      fs.rmSync(target, { force: true, recursive: true });
    }
  }
  if (!existingDirectories.has(root)) {
    try {
      fs.rmdirSync(root);
    } catch {}
  }
}

const desktopFiles = directory =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? desktopFiles(fullPath)
      : [path.relative(path.join(templatesDir, 'app'), fullPath)];
  });

/// A number as a Rust float literal.
function asFloat(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * The `main.rs` an app's `desktop.json` describes.
 *
 * The window, dev-menu and tray chain is unchanged from when these options
 * lived in `app.json`; only where they are read from moved.
 */
export function desktopLaunchConfig(config, configPath) {
  const settings = config.window ?? {};
  const title =
    settings.title === undefined
      ? 'env!("RN_GPUI_APP_NAME")'
      : JSON.stringify(settings.title);
  const width = settings.width;
  const height = settings.height;

  // `window_size` takes `f32`: a JSON number reaches Rust as `1024`, which is
  // an integer literal and does not coerce.
  const chain = [
    `    .window_title(${title})`,
    `    .window_size(${asFloat(width)}, ${asFloat(height)})`,
  ];
  if (settings.position !== undefined) {
    const { x, y } = settings.position;
    if (x === undefined || y === undefined) {
      throw new Error(
        `desktop/desktop.json window.position needs x and y: ${configPath}`,
      );
    }
    chain.push(`    .window_position(${asFloat(x)}, ${asFloat(y)})`);
  }
  if (settings.restoreState === false) {
    chain.push('    .restore_window_state(false)');
  }
  if (settings.menuBar === false) {
    // Only meaningful where the bar is drawn inside the window; macOS ignores it,
    // and the `menuBarInWindow` capability says so.
    chain.push('    .menu_bar(false)');
  }
  if (settings.titleBar !== undefined && settings.titleBar !== 'default') {
    // The default is the platform's own bar, so only the two custom kinds are
    // emitted. The enum is spelled out in full because the generated file has no
    // `use` lines to import it with.
    const variant = settings.titleBar === 'hidden' ? 'Hidden' : 'Transparent';
    chain.push(`    .title_bar(react_native_gpui::WindowTitleBar::${variant})`);
  }
  if (settings.trafficLightPosition !== undefined) {
    const { x, y } = settings.trafficLightPosition;
    if (x === undefined || y === undefined) {
      throw new Error(
        `desktop/desktop.json window.trafficLightPosition needs x and y: ${configPath}`,
      );
    }
    chain.push(`    .traffic_light_position(${asFloat(x)}, ${asFloat(y)})`);
  }
  chain.push(`    .dev_menu(${config.devMenu})`);
  if (config.tray !== undefined) {
    const tray = config.tray;
    let trayChain = 'TrayConfig::default()';
    if (tray.component !== undefined) {
      trayChain += `.component(${JSON.stringify(tray.component)})`;
    }
    if (tray.tooltip !== undefined) {
      trayChain += `.tooltip(${JSON.stringify(tray.tooltip)})`;
    }
    if (tray.icon !== undefined) {
      // Embedded, so a packaged app needs no file beside it.
      const iconPath = JSON.stringify(`/${tray.icon.replaceAll('\\', '/')}`);
      trayChain += `.icon_bytes(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), ${iconPath})))`;
      trayChain += `.icon_template(${tray.iconTemplate === true})`;
    }
    if (tray.accessory === false) {
      trayChain += '.accessory(false)';
    }
    chain.push(`    .tray(${trayChain})`);
  }
  chain.push(`    .configure_window(|options| {
        // GPUI window options are public: titlebar, resizability, display,
        // decorations, min size, and other native window behavior.
        options.is_resizable = ${settings.resizable === false ? 'false' : 'true'};
    })`);

  return `//! Project-owned desktop launch configuration.
//!
//! Generated by \`init-desktop\` from \`desktop/desktop.json\`; edit that file and
//! re-run \`npx react-native init-desktop\`, or this file directly. See
//! \`desktop/README.md\` for the full set of options.
//!
//! Add \`mod my_turbo_module;\` here for local Rust TurboModules. Put matching
//! \`Native*.ts\` specs beside this file; \`run-desktop\` discovers and codegens
//! those specs automatically.

fn main() {
    // A debug build knows where its own bundle is; a release build does not, and
    // must not: the path would name the machine that built it. A packaged release
    // app resolves the bundle beside its executable instead.
    #[cfg(debug_assertions)]
    if std::env::var_os("RN_GPUI_BUNDLE").is_none() {
        std::env::set_var("RN_GPUI_BUNDLE", env!("RN_GPUI_DEFAULT_BUNDLE"));
    }
    let config = react_native_gpui::DesktopAppConfig::from_env_with_defaults(
        env!("RN_GPUI_APP_NAME"),
        env!("RN_GPUI_APP_ID"),
    )
${chain.join('\n')};

    react_native_gpui::run_with(config);
}
`;
}

/// The file that pulls the published type augmentation into an app's build.
const ENV_TYPES_FILE = 'react-native-gpui-env.d.ts';
const ENV_TYPES_CONTENT = `/// <reference types="@react-native-gpui/core/types" />
// Added by react-native-gpui. Do not edit: it is regenerated.
`;

export function scaffoldDesktop(
  projectRoot,
  packageJson,
  { preserveExisting = false, beforeWrite = () => {} } = {},
) {
  const desktopTemplate = path.join(templatesDir, 'app/desktop');
  for (const relativePath of desktopFiles(desktopTemplate)) {
    const targetRelativePath =
      relativePath === 'desktop/gitignore'
        ? 'desktop/.gitignore'
        : relativePath;
    const target = path.join(projectRoot, targetRelativePath);
    if (preserveExisting && fs.existsSync(target)) continue;
    beforeWrite(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(templatesDir, 'app', relativePath), target);
  }

  const cargoPath = path.join(projectRoot, 'desktop/Cargo.toml');
  if (!preserveExisting || !fs.existsSync(cargoPath)) {
    beforeWrite(cargoPath);
    fs.writeFileSync(
      cargoPath,
      `[package]\nname = ${JSON.stringify(appPackageName(projectRoot, packageJson))}\nversion = "0.1.0"\nedition = "2021"\n\n# Set CARGO_PROFILE_DEV_DEBUG=full to opt into full debug information.\n[profile.dev]\ndebug = "line-tables-only"\nsplit-debuginfo = "packed"\n\n# Dependencies are optimized even in a dev build: GPUI rebuilds and paints the\n# element tree on every frame, and they are only compiled once.\n[profile.dev.package."*"]\ndebug = false\nopt-level = 3\n\n# The C++ bridge picks its CMake build type from this crate's opt-level, and a\n# Release build of React Native has no dev server, inspector or Fast Refresh.\n[profile.dev.package.rn-gpui-sys]\nopt-level = 0\n\n[profile.release]\ndebug = "line-tables-only"\n# Cargo strips inside the linker, before dsymutil, so package-desktop writes the\n# dSYM and then strips. Full LTO: 2 MB smaller for 1.4x the build time.\nstrip = "none"\nsplit-debuginfo = "packed"\nlto = "fat"\ncodegen-units = 1\n\n[build-dependencies]\nserde_json = "1"\n\n[dependencies]\n`,
    );
  }

  // The type augmentation for the desktop View props is global, and a TypeScript
  // augmentation only applies when the file declaring it is compiled. This
  // reference is what puts it in the app's compilation, the way Next.js and Vite
  // write theirs, so `desktopDragRegion` and `onContextMenu` type-check without an
  // import of the desktop entry point.
  const envPath = path.join(projectRoot, ENV_TYPES_FILE);
  if (!preserveExisting || !fs.existsSync(envPath)) {
    beforeWrite(envPath);
    fs.writeFileSync(envPath, ENV_TYPES_CONTENT);
  }

  const appConfigPath = path.join(projectRoot, 'app.json');
  if (!fs.existsSync(appConfigPath)) {
    throw new Error(`missing React Native app config: ${appConfigPath}`);
  }
  const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'));
  if (typeof appConfig.name !== 'string' || appConfig.name.length === 0) {
    throw new Error(`app.json must define a nonempty name: ${appConfigPath}`);
  }
  // Every launch setting comes from `desktop/desktop.json`; `app.json`'s old
  // `desktop` key is rejected by the loader with a pointer to the new file.
  const launchConfig = desktopLaunchConfig(
    loadDesktopConfig(projectRoot, process.platform),
    path.join(projectRoot, 'desktop/desktop.json'),
  );
  if (launchConfig !== null) {
    const mainPath = path.join(projectRoot, 'desktop/src/main.rs');
    if (!preserveExisting || !fs.existsSync(mainPath)) {
      beforeWrite(mainPath);
      fs.writeFileSync(mainPath, launchConfig);
    }
  }

  const updatedPackageJson = {
    ...packageJson,
    dependencies: {
      ...packageJson.dependencies,
      '@react-native-gpui/core':
        packageJson.dependencies?.['@react-native-gpui/core'] ?? '^0.1.0',
      '@react-native-gpui/hermes':
        packageJson.dependencies?.['@react-native-gpui/hermes'] ?? '^0.1.0',
      // `rn-gpui-module-build` resolves its spec generator from the app
      // (`require.resolve('@react-native-gpui/codegen/generate-rust-spec')` with
      // the crate directory as the search path), so the app must depend on it
      // directly. Inside this repository the workspace hoists it and a missing
      // entry goes unnoticed; an app installed from the registry fails with
      // "Cannot find module '@react-native-gpui/codegen/generate-rust-spec'".
      '@react-native-gpui/codegen':
        packageJson.dependencies?.['@react-native-gpui/codegen'] ?? '^0.1.0',
    },
    scripts: {
      ...packageJson.scripts,
      'test:e2e':
        packageJson.scripts?.['test:e2e'] ??
        'vitest run --config desktop/vitest.e2e.config.ts',
    },
    devDependencies: {
      ...packageJson.devDependencies,
      vitest: packageJson.devDependencies?.vitest ?? '^3.2.4',
      '@react-native-gpui/testing':
        packageJson.devDependencies?.['@react-native-gpui/testing'] ?? '^0.1.0',
      '@react-native-gpui/cli':
        packageJson.devDependencies?.['@react-native-gpui/cli'] ?? '^0.1.0',
    },
  };
  return updatedPackageJson;
}

export function initDesktop({
  projectRoot = process.cwd(),
  skipInstall = false,
}) {
  projectRoot = path.resolve(projectRoot);
  const snapshots = new Map();
  const createdDirectories = new Set();
  const existingDirectories = new Set();
  const track = file => {
    if (!snapshots.has(file)) {
      snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    }
  };
  try {
    const packagePath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(packagePath)) {
      throw new Error(`no package.json found in ${projectRoot}`);
    }
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (
      !packageJson.dependencies?.['react-native'] &&
      !packageJson.devDependencies?.['react-native']
    ) {
      throw new Error('package.json does not declare react-native');
    }

    const updatedPackageJson = scaffoldDesktop(projectRoot, packageJson, {
      preserveExisting: true,
      beforeWrite(file) {
        track(file);
        let directory = path.dirname(file);
        const missingDirectories = [];
        while (directory.startsWith(projectRoot) && !fs.existsSync(directory)) {
          missingDirectories.push(directory);
          directory = path.dirname(directory);
        }
        missingDirectories.forEach(item => createdDirectories.add(item));
      },
    });
    track(packagePath);
    fs.writeFileSync(
      packagePath,
      `${JSON.stringify(updatedPackageJson, null, 2)}\n`,
    );

    if (!skipInstall) {
      const manager = fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(projectRoot, 'yarn.lock'))
          ? 'yarn'
          : fs.existsSync(path.join(projectRoot, 'bun.lockb')) ||
              fs.existsSync(path.join(projectRoot, 'bun.lock'))
            ? 'bun'
            : 'npm';
      for (const lock of [
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lock',
        'bun.lockb',
      ]) {
        const file = path.join(projectRoot, lock);
        track(file);
      }
      run(manager, ['install'], { cwd: projectRoot });
    }

    const desktopRoot = path.join(projectRoot, 'desktop');
    const autolinkRoot = path.join(desktopRoot, 'autolink');
    const buildRoot = path.join(desktopRoot, 'build');
    const rememberDirectory = directory => {
      for (
        let current = directory;
        current.startsWith(projectRoot) && !fs.existsSync(current);
        current = path.dirname(current)
      ) {
        createdDirectories.add(current);
      }
    };
    snapshotTree(autolinkRoot, track, rememberDirectory, existingDirectories);
    const assetsRoot = path.join(buildRoot, 'assets');
    snapshotTree(assetsRoot, track, rememberDirectory, existingDirectories);
    const bundlePath = path.join(buildRoot, 'index.bundle');
    track(bundlePath);
    track(path.join(desktopRoot, 'Cargo.toml'));
    track(path.join(desktopRoot, 'src/main.rs'));
    autolink({ projectRoot });

    if (!fs.existsSync(bundlePath)) {
      rememberDirectory(assetsRoot);
      run(
        npxCommand,
        npxArgs([
          'react-native',
          'bundle',
          '--platform',
          'desktop',
          '--entry-file',
          ['index.js', 'index.ts', 'index.tsx'].find(file =>
            fs.existsSync(path.join(projectRoot, file)),
          ) ?? 'index.js',
          '--bundle-output',
          bundlePath,
          '--assets-dest',
          assetsRoot,
          '--config',
          path.join(desktopRoot, 'metro.config.js'),
          '--dev',
          'false',
        ]),
        { cwd: projectRoot, shell: npxShell },
      );
    }
    console.log(
      `Added GPUI desktop support to ${projectRoot}. Run npx react-native run-desktop.`,
    );
  } catch (error) {
    removeNewFiles(
      path.join(projectRoot, 'desktop/autolink'),
      snapshots,
      existingDirectories,
    );
    removeNewFiles(
      path.join(projectRoot, 'desktop/build/assets'),
      snapshots,
      existingDirectories,
    );
    const bundlePath = path.join(projectRoot, 'desktop/build/index.bundle');
    if (snapshots.get(bundlePath) === null) {
      fs.rmSync(bundlePath, { force: true });
    }
    for (const [file, contents] of [...snapshots.entries()].reverse()) {
      if (contents === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, contents);
    }
    for (const directory of [...createdDirectories].sort(
      (left, right) => right.length - left.length,
    )) {
      try {
        fs.rmdirSync(directory);
      } catch {}
    }
    console.error(
      `init-desktop failed and restored its file changes: ${error.message}`,
    );
    console.error('Manual steps to add desktop support:');
    for (const step of [
      'Install @react-native-gpui/core and @react-native-gpui/cli in the app.',
      'Copy the desktop/ scaffold from @react-native-gpui/cli/templates/app/desktop.',
      'Add react-native-gpui-env.d.ts to the app root: /// <reference types="@react-native-gpui/core/types" />',
      'Run npm install (or your package manager), then npx react-native run-desktop.',
    ]) {
      console.error(`  - ${step}`);
    }
    throw error;
  }
}

export function initProject({ appName, destination, initArgs = [] }) {
  destination = path.resolve(destination);
  const destinationExisted = fs.existsSync(destination);
  if (destinationExisted && fs.readdirSync(destination).length) {
    throw new Error(`destination is not empty: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    run(
      npxCommand,
      npxArgs([
        '--yes',
        '@react-native-community/cli@^20.2.0',
        'init',
        appName,
        '--version',
        '0.87.1',
        '--skip-install',
        '--directory',
        destination,
        ...initArgs,
      ]),
      { shell: npxShell },
    );
    const packagePath = path.join(destination, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    fs.writeFileSync(
      packagePath,
      `${JSON.stringify(scaffoldDesktop(destination, packageJson), null, 2)}\n`,
    );
    fs.copyFileSync(
      path.join(templatesDir, 'app/App.tsx'),
      path.join(destination, 'App.tsx'),
    );
    console.log(
      `Created standard React Native project ${appName} (iOS, Android, and GPUI desktop) in ${destination}. Run npm install, then npx react-native run-desktop.`,
    );
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    if (destinationExisted) fs.mkdirSync(destination, { recursive: true });
    throw error;
  }
}

export function createLibrary({
  libraryName,
  type = 'rust',
  destination,
  moduleName: requestedModuleName,
  packageName: requestedPackageName,
}) {
  if (
    !libraryName ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(libraryName) ||
    !['rust', 'cpp'].includes(type)
  ) {
    throw new Error(
      'create-library requires a valid name and rust or cpp type',
    );
  }
  destination = path.resolve(destination ?? libraryName);
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    throw new Error(`destination is not empty: ${destination}`);
  }
  const slug = libraryName
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, '-');
  const snakeCase = value =>
    value
      .replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
      .toLowerCase();
  const words = libraryName.match(/[A-Z]?[a-z0-9]+|[A-Z]+/gu) ?? [libraryName];
  const moduleStem = words
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join('');
  const moduleName = requestedModuleName ?? `RN${moduleStem}Module`;
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(moduleName)) {
    throw new Error('--module-name must be a PascalCase identifier');
  }
  const specName = `Native${moduleStem}`;
  const cppProvider = `create_${slug.replaceAll('-', '_')}_module`;
  const packageName = requestedPackageName ?? `react-native-${slug}`;
  // Two names have to line up: `<codegenName>JSI.h` is the generated header, and
  // the spec class is named after the spec file (`src/${specName}.ts`). The C++
  // template writes `RNModuleSpec` and `NativeModuleCxxSpec`, which the
  // replacements below turn into exactly these two names.
  const codegenName = `${moduleName}Spec`;
  const templateRoot = path.join(templatesDir, `modules/${type}`);
  fs.mkdirSync(destination, { recursive: true });
  const moduleFiles =
    type === 'rust'
      ? {
          [`src/${specName}.ts`]: 'NativeModule.ts',
          'src/index.ts': 'index.ts',
          'desktop/build.rs': 'build.rs',
          'desktop/src/lib.rs': 'lib.rs',
        }
      : {
          [`src/${specName}.ts`]: 'NativeModule.ts',
          'src/index.ts': 'index.ts',
          [`desktop/cpp/${moduleName}.hpp`]: 'RNModule.hpp',
          [`desktop/cpp/${moduleName}.cpp`]: 'RNModule.cpp',
          'desktop/CMakeLists.txt': 'CMakeLists.txt',
        };
  for (const [target, source] of Object.entries(moduleFiles)) {
    const targetPath = path.join(destination, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const contents = fs
      .readFileSync(path.join(templateRoot, source), 'utf8')
      .replaceAll('RNMODULESNAKE', snakeCase(moduleStem))
      .replaceAll('NativeModule', specName)
      .replaceAll('RNMODULE', moduleName.toUpperCase())
      .replaceAll('RNModule', moduleName)
      .replaceAll('create_rn_module', cppProvider);
    fs.writeFileSync(targetPath, contents);
  }

  const platformConfig =
    type === 'rust'
      ? { crate: `rn-gpui-${slug}` }
      : { cmake: 'desktop', cppProvider };
  const packageJson = {
    name: packageName,
    version: '0.1.0',
    main: 'src/index.ts',
    files: ['src', 'desktop', 'react-native.config.js', 'README.md'],
    codegenConfig: {
      name: codegenName,
      type: 'modules',
      jsSrcsDir: 'src',
    },
    peerDependencies: { 'react-native': '>=0.76' },
  };
  fs.writeFileSync(
    path.join(destination, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(destination, 'react-native.config.js'),
    [
      'module.exports = {',
      '  dependency: {',
      '    platforms: {',
      '      desktop: {',
      ...Object.entries(platformConfig).map(
        ([key, value]) => `        ${key}: ${JSON.stringify(value)},`,
      ),
      '      },',
      '    },',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  if (type === 'rust') {
    // Version requirements, not paths: `[patch.crates-io]` cannot redirect a
    // `path` dependency, and a module installed from npm has no
    // `../../../packages` above it. Autolink patches these to the core the app
    // actually installed.
    fs.writeFileSync(
      path.join(destination, 'desktop/Cargo.toml'),
      `[package]\nname = ${JSON.stringify(`rn-gpui-${slug}`)}\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nrn-gpui-module = "0.1"\n\n[build-dependencies]\nrn-gpui-module-build = "0.1"\n`,
    );
  }
  const exampleRoot = path.join(destination, 'example');
  fs.mkdirSync(exampleRoot, { recursive: true });
  fs.writeFileSync(
    path.join(exampleRoot, 'app.json'),
    `${JSON.stringify({ name: `${moduleStem}Example`, displayName: `${moduleStem} Example` }, null, 2)}\n`,
  );
  const examplePackage = scaffoldDesktop(exampleRoot, {
    name: `${slug}-example`,
    version: '0.0.1',
    private: true,
    dependencies: {
      react: '19.2.3',
      'react-native': '0.87.1',
      [packageName]: 'file:..',
    },
    devDependencies: {
      '@react-native-community/cli': '^20.2.0',
      '@react-native/babel-preset': '0.87.1',
      '@react-native/metro-config': '0.87.1',
      vitest: '^3.2.4',
    },
  });
  fs.writeFileSync(
    path.join(exampleRoot, 'package.json'),
    `${JSON.stringify(examplePackage, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(exampleRoot, 'babel.config.cjs'),
    "module.exports = {presets: ['module:@react-native/babel-preset']};\n",
  );
  fs.writeFileSync(
    path.join(exampleRoot, 'index.ts'),
    "import {AppRegistry} from 'react-native';\nimport App from './App';\nimport {name} from './app.json';\nAppRegistry.registerComponent(name, () => App);\n",
  );
  fs.writeFileSync(
    path.join(exampleRoot, 'App.tsx'),
    `import React from 'react';\nimport {Text, View} from 'react-native';\nimport Module from ${JSON.stringify(packageName)};\nexport default function App() {\n  return <View testID="desktop-app-root" style={{flex: 1, padding: 32}}><Text testID="library-result">{Module.greet('Desktop')}</Text></View>;\n}\n`,
  );
  fs.writeFileSync(
    path.join(exampleRoot, 'desktop/e2e/library.e2e.ts'),
    "import {launchApp, expect as desktopExpect} from '@react-native-gpui/testing';\ntest('calls the native library', async () => {\n  const app = await launchApp({disableAnimations: true});\n  await desktopExpect(app.getByTestId('library-result')).toContainText('Desktop');\n});\n",
  );

  const language = type === 'rust' ? 'Rust' : 'C++';
  const implementation =
    type === 'rust' ? 'desktop/src/lib.rs' : `desktop/cpp/${moduleName}.cpp`;
  const description =
    type === 'rust'
      ? 'call its typed greet(name) method.'
      : 'implement methods defined by its generated spec.';
  fs.writeFileSync(
    path.join(destination, 'README.md'),
    `# ${libraryName}\n\n${language} TurboModule library for React Native GPUI. The spec is in src/${specName}.ts and uses React Native's public TurboModuleRegistry API. The implementation is in ${implementation} and is discovered through package metadata. Import the default export from ${packageName} and ${description}\n`,
  );
  console.log(
    `Created ${type} TurboModule library ${packageName} in ${destination}. Install/link it in a React Native app, then run npx react-native run-desktop.`,
  );
}

/**
 * The `_requireNodeLibrary(key, path)` calls the Babel plugin emits, as they
 * appear in a bundle. Babel's output quotes both arguments with double quotes
 * and escapes anything unusual, so this matches the compact and pretty forms
 * alike. The key never contains a quote or a backslash (see the plugin's
 * `addonKey`), which is what keeps the pattern simple.
 */
const requireNodeLibraryCallPattern =
  /_requireNodeLibrary\(\s*"([^"\\]+)"\s*,\s*"((?:[^"\\]|\\.)+)"\s*\)/gu;

/**
 * The Node addon entries a bundle asks for: `{ key, path }`, in the order the
 * calls appear, with the escapes Babel produced removed from the path.
 *
 * Exported for the unit test: scanning is the part worth testing without
 * touching the filesystem.
 */
export function scanNodeAddonCalls(bundleText) {
  const found = [];
  const seen = new Set();
  for (const match of bundleText.matchAll(requireNodeLibraryCallPattern)) {
    const key = match[1];
    // The path was emitted by `t.stringLiteral`, so it is escaped the way a JS
    // string literal is. `JSON.parse` undoes exactly that.
    let filePath;
    try {
      filePath = JSON.parse(`"${match[2]}"`);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ key, path: filePath });
  }
  return found;
}

/** Sibling shared libraries a `$ORIGIN` / `@loader_path` lookup may need. */
function isSiblingSharedLibrary(name, platform) {
  if (platform === 'darwin') return name.endsWith('.dylib');
  if (platform === 'win32') return name.endsWith('.dll');
  // Linux: `libfoo.so` and its versioned forms `libfoo.so.1`, `libfoo.so.1.2`.
  return /\.so(?:\.\d+)*$/u.test(name);
}

/**
 * `react-native-gpui collect-node-addons --bundle <bundle.js> --out <dir>`
 *
 * A development build loads an addon from the absolute path the Babel plugin
 * embedded. A packaged app has no such path, so it copies each addon to
 * `<out>/<key>` — which is what `_requireNodeLibrary` looks for relative to the
 * executable — together with any sibling shared libraries, since some addons
 * load those through `$ORIGIN` / `@loader_path`.
 *
 * Fails loudly when an embedded path no longer exists: a bundle built against a
 * stale tree would otherwise ship without the addon and fail at run time.
 */
export function collectNodeAddons({
  bundle,
  out,
  platform = process.platform,
} = {}) {
  if (!bundle) throw new Error('collect-node-addons requires --bundle <path>');
  if (!out) throw new Error('collect-node-addons requires --out <dir>');
  const bundlePath = path.resolve(bundle);
  const outDirectory = path.resolve(out);
  const bundleText = fs.readFileSync(bundlePath, 'utf8');
  const addons = scanNodeAddonCalls(bundleText);
  if (addons.length === 0) {
    // A bundle with no addons removes a stale directory rather than leaving one
    // from an earlier build behind.
    fs.rmSync(outDirectory, { recursive: true, force: true });
    console.log(`No Node addons in ${bundlePath}; removed ${outDirectory}.`);
    return { copied: [], out: outDirectory };
  }

  const missing = addons.filter(addon => !fs.existsSync(addon.path));
  if (missing.length > 0) {
    throw new Error(
      `collect-node-addons: the bundle names ${missing.length} addon file(s) ` +
        'that no longer exist. Rebuild the bundle before packaging:\n' +
        missing.map(addon => `  ${addon.key} -> ${addon.path}`).join('\n'),
    );
  }

  // Rebuilt from scratch so an addon that disappeared is not shipped.
  fs.rmSync(outDirectory, { recursive: true, force: true });
  const copied = [];
  for (const addon of addons) {
    const target = path.join(outDirectory, addon.key);
    if (!target.startsWith(outDirectory + path.sep)) {
      throw new Error(
        `collect-node-addons: key '${addon.key}' escapes ${outDirectory}`,
      );
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(addon.path, target);
    copied.push({ key: addon.key, path: addon.path, target });

    // Sibling shared libraries of the same directory, copied once per
    // directory so two addons in one folder do not copy them twice.
    for (const sibling of fs.readdirSync(path.dirname(addon.path))) {
      if (sibling === path.basename(addon.path)) continue;
      if (!isSiblingSharedLibrary(sibling, platform)) continue;
      const source = path.join(path.dirname(addon.path), sibling);
      if (!fs.statSync(source).isFile()) continue;
      const siblingKey = path.join(path.dirname(addon.key), sibling);
      const siblingTarget = path.join(outDirectory, siblingKey);
      if (!siblingTarget.startsWith(outDirectory + path.sep)) continue;
      if (fs.existsSync(siblingTarget)) continue;
      fs.mkdirSync(path.dirname(siblingTarget), { recursive: true });
      fs.copyFileSync(source, siblingTarget);
      copied.push({ key: siblingKey, path: source, target: siblingTarget });
    }
  }

  for (const entry of copied) {
    console.log(`  ${entry.key}  <-  ${entry.path}`);
  }
  console.log(
    `Copied ${addons.length} Node addon(s) and ${copied.length - addons.length} sibling librar(ies) to ${outDirectory}.`,
  );
  return { copied, out: outDirectory };
}

/// The first four bytes of a Hermes bytecode file.
///
/// Hermes identifies its output by content, and React Native's loader does too:
/// the file extension is not consulted, which is why a `.bundle` holding
/// bytecode works. The magic is `c6 1f bc 03`, followed by the version.
const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03]);

/**
 * Strip the symbol table from the release binary, once its debug info is safe.
 *
 * Cargo's own `strip = "symbols"` runs inside the linker, before `dsymutil`, so
 * it leaves an empty dSYM. Stripping here instead — after the dSYM is written and
 * before the packager copies the binary — gets both: a 10 MB smaller binary and
 * a debug file that can symbolize a crash.
 */
function stripReleaseBinary({ crateDir, binaryName }) {
  const binary = path.join(targetProfileDir(crateDir, 'release'), binaryName);
  if (!fs.existsSync(binary)) return;
  try {
    if (process.platform === 'win32') return; // The linker already omits it.
    // `-x` removes every symbol that is not exported, which is the 10 MB the
    // symbol table costs. `-S` only removes debug info and leaves the table.
    execFileSync('strip', ['-x', binary], { stdio: 'inherit' });
    console.log(`stripped symbols from ${path.basename(binary)}`);
  } catch {
    console.log(
      `could not strip ${path.basename(binary)}; the package will be larger`,
    );
  }
}

/**
 * Copy the bundle a release should ship to `desktop/build/package/index.bundle`.
 *
 * One name, one file, and the content is whatever the engine produced. A
 * Hermes build ships bytecode; a JavaScript-only engine ships JavaScript under
 * the same name, with one line saying so. The name never varies, so the runtime
 * has nothing to guess and `Resources/` holds exactly one bundle.
 */
function stageBundle({ projectRoot, build }) {
  const packageDir = path.join(projectRoot, 'desktop', 'build', 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  const staged = path.join(packageDir, 'index.bundle');
  const source = build?.runtimeBundlePath;
  if (typeof source !== 'string' || !fs.existsSync(source)) {
    throw new Error(
      `the release bundle was not produced: expected ${source ?? '(no path)'}`,
    );
  }
  fs.copyFileSync(source, staged);

  const head = Buffer.alloc(HERMES_MAGIC.length);
  const fd = fs.openSync(staged, 'r');
  try {
    fs.readSync(fd, head, 0, HERMES_MAGIC.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.equals(HERMES_MAGIC)) return staged;

  // Not bytecode. That is correct for a JavaScript-only engine and a packaging
  // mistake with Hermes, so the two are told apart by whether the engine claims
  // to compile at all.
  const engine = loadEngineBundle(projectRoot);
  if (engine && typeof engine.compile === 'function') {
    throw new Error(
      `the Hermes engine did not produce bytecode: ${source} starts with ` +
        `${JSON.stringify(head.toString('latin1'))}, not the Hermes magic`,
    );
  }
  console.log(
    'packaging a JavaScript bundle: the active engine compiles to bytecode only with Hermes',
  );
  return staged;
}

/// The `name` a desktop crate declares in its Cargo.toml.
function desktopCrateName(crateDir) {
  const manifest = fs.readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
  const match = manifest.match(/^name\s*=\s*"([^"]+)"/mu);
  if (!match) {
    throw new Error(`no package name in ${path.join(crateDir, 'Cargo.toml')}`);
  }
  return match[1];
}

/**
 * `package-desktop`: turn the app into installable packages for this OS.
 *
 * Always a release build. The steps are: load the config, produce the release
 * bundle and binary the way `run-desktop --release` does, translate the config
 * into cargo-packager's, and run it. cargo-packager is an implementation
 * detail — nothing here writes its format by hand.
 */
export async function packageDesktop({
  projectRoot = process.cwd(),
  targets,
  outDir,
} = {}) {
  projectRoot = path.resolve(projectRoot);
  const config = loadDesktopConfig(projectRoot, process.platform);
  // `--target` reaches the command as the string after the flag.
  const requested =
    targets === undefined || targets === true
      ? config
      : {
          ...config,
          bundle: {
            ...config.bundle,
            targets: String(targets)
              .split(',')
              .map(format => format.trim())
              .filter(Boolean),
          },
        };
  const formats = targetsFor(requested, process.platform);

  // 1. The release bundle and binary. `packaging` makes build.rs emit only
  //    relative rpaths, so the result carries no path into this build tree.
  const build = await runDesktop({
    projectRoot,
    release: true,
    noLaunch: true,
    packaging: true,
  });
  // What the release ships: one bundle, always named `index.bundle`, holding
  // whatever the engine compiled the JavaScript into. React Native's own release
  // builds do the same — an iOS `main.jsbundle` is bytecode when Hermes is on.
  const shippedBundle = stageBundle({ projectRoot, build });

  const crateDir = path.join(projectRoot, 'desktop');
  // The executable is the crate's name, which is what `scaffoldDesktop` writes
  // into Cargo.toml and what `cargo build` produces.
  const binaryName = desktopCrateName(crateDir);
  const buildDir = path.join(crateDir, 'build');

  // The binary is finished. Ask for the debug file first — it can only be
  // collected from a binary that still has its debug info — then take the symbols
  // off, so the packager copies the small binary.
  ensureDsym({ crateDir, binaryName });
  stripReleaseBinary({ crateDir, binaryName });

  // 2. Icons, from the one PNG the config names.
  const icons = generateIcons(config, { crateDir, projectRoot });

  // 3. The libraries that have to travel with the app.
  const libraries = runtimeLibraries(projectRoot, {
    os: process.platform,
    arch: process.arch,
    release: true,
  });
  // Named, because a library left out of the package is otherwise invisible until
  // the installer or the AppImage step fails with a message that does not say
  // which file it was looking for.
  for (const library of libraries) {
    console.log(`shipping library ${path.basename(library)}`);
  }

  // 4. Translate, then run cargo-packager.
  // The rpath `build.rs` emits names the app, not the crate: it is
  // `RN_GPUI_APP_NAME`, which comes from `app.json`. The deb has to install its
  // libraries into that same directory or the binary cannot find them.
  const appJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'),
  );
  const packagerConfig = toPackagerConfig(config, {
    crateDir,
    binaryName,
    rpathDir: appJson.name,
    os: desktopOs(process.platform),
    bundleDir: path.dirname(shippedBundle),
    assetsDir: path.join(buildDir, 'assets'),
    icons,
    libraries,
    formats,
    ...(outDir === undefined ? {} : { outDir: path.resolve(outDir) }),
  });
  // The config is written at the crate root, not in `build/`: cargo-packager
  // resolves every path in it — the binary, the resources, the frameworks —
  // relative to the config file's own directory, so a config one level down
  // would look for `build/build/index.bundle`.
  const configPath = path.join(crateDir, 'packager.json');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(packagerConfig, null, 2)}\n`);

  ensureCargoPackager();
  run(
    'cargo',
    ['packager', '--config', 'packager.json', '--formats', formats.join(',')],
    { cwd: crateDir },
  );

  fs.rmSync(configPath, { force: true });
  const produced = listPackages(packagerConfig.outDir);
  // After the packages, not before: cargo-packager writes `dist` itself and would
  // remove anything already there.
  copyDebugSymbols({ crateDir, binaryName, outDir: packagerConfig.outDir });
  for (const file of produced) console.log(file);
  return produced;
}

/**
 * Installs cargo-packager when the pinned version is not the one on PATH.
 *
 * One line saying so: the install takes a few minutes and happens once.
 */
export function ensureCargoPackager() {
  let installed;
  try {
    installed = execFileSync('cargo', ['packager', '--version'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    installed = '';
  }
  if (installed.includes(CARGO_PACKAGER_VERSION)) return;
  console.log(
    `installing cargo-packager ${CARGO_PACKAGER_VERSION} (once, a few minutes)`,
  );
  run(
    'cargo',
    [
      'install',
      'cargo-packager',
      '--locked',
      '--version',
      CARGO_PACKAGER_VERSION,
    ],
    {},
  );
}

/**
 * Write the release dSYM if it is not there yet.
 *
 * Cargo does not invoke `dsymutil`, so a binary built with `strip = "none"` still
 * has no dSYM until one is asked for. This must happen before `stripReleaseBinary`
 * — the debug info has to be in the binary to be collected out of it.
 */
function ensureDsym({ crateDir, binaryName }) {
  const profileDir = targetProfileDir(crateDir, 'release');
  const binary = path.join(profileDir, binaryName);
  const dsym = path.join(profileDir, `${binaryName}.dSYM`);
  if (!fs.existsSync(binary)) return;
  // `dsymutil` writes the bundle read-only, and Cargo then cannot replace the
  // binary it belongs to: "failed to remove file … Operation not permitted". Make
  // it writable before removing it.
  if (fs.existsSync(dsym)) fs.chmodSync(dsym, 0o755);
  fs.rmSync(dsym, { recursive: true, force: true });
  try {
    execFileSync('dsymutil', [binary, '-o', dsym], { stdio: 'inherit' });
    // `dsymutil` writes the bundle read-only, and Cargo then cannot replace the
    // binary it belongs to: "failed to remove file … Operation not permitted".
    if (fs.existsSync(dsym)) fs.chmodSync(dsym, 0o755);
  } catch (error) {
    console.log(`could not write a dSYM for ${binaryName}: ${error.message}`);
  }
}

/// Whether `file` is a directory with no files anywhere below it.
function isEmptyDirectory(file) {
  const stat = fs.statSync(file);
  if (!stat.isDirectory()) return false;
  const stack = [file];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) return false;
      if (entry.isDirectory()) stack.push(path.join(directory, entry.name));
    }
  }
  return true;
}

/**
 * Put the release debug file beside the package, and not inside it.
 *
 * The binary is stripped of its symbol table, so a crash report is addresses and
 * nothing else. The dSYM (or `.dwp`, or `.pdb`) is what turns those back into
 * function names, and it must not ship: it is larger than the binary and useless
 * to anyone who is not symbolizing.
 */
function copyDebugSymbols({ crateDir, binaryName, outDir }) {
  const profileDir = targetProfileDir(crateDir, 'release');
  // `split-debuginfo = "packed"` gives a dSYM on macOS, a `.dwp` on Linux and a
  // `.pdb` on Windows. The unpacked `.debug` file is listed too because a
  // toolchain that does not support packing falls back to it.
  const candidates = [
    path.join(profileDir, `${binaryName}.dSYM`),
    path.join(profileDir, `${binaryName}.dwp`),
    path.join(profileDir, `${binaryName}.pdb`),
    path.join(profileDir, `${binaryName}.debug`),
  ];
  // A dSYM directory that exists but holds no DWARF is a leftover, not a result.
  const found = candidates.filter(
    file => fs.existsSync(file) && !isEmptyDirectory(file),
  );
  if (found.length === 0) {
    console.log(
      'no release debug file was produced; a crash report will not be symbolizable',
    );
    return;
  }
  for (const file of found) {
    const target = path.join(outDir, path.basename(file));
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(file, target, { recursive: true });
    // A read-only directory here would make the next run fail to replace it.
    fs.chmodSync(target, 0o755);
    console.log(`debug symbols: ${target}`);
  }
}

/** The packages a run produced, newest first. */
function listPackages(outDir) {
  let entries;
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(outDir, entry.name))
    .sort();
}

/**
 * The icon a package builds from: the one `desktop.json` names, or the CLI's
 * placeholder.
 *
 * cargo-packager derives a macOS `.icns` entry from an icon's pixel size times
 * its density, and only a handful of those pairs are ICNS types. A 1024x1024
 * PNG at 1x is not one of them, so a single file fails with "No matching
 * IconType" — which is what stopped the app bundle as well as the AppImage.
 * Naming the copy `@2x` says what the file is: a 1024px asset for a 512pt slot,
 * which is a valid type, and every other format is derived from it.
 *
 * The `@2x` convention is cargo-packager's own, and the copy is why no image
 * library is needed: the CLI never rescales a user's icon, it labels it.
 *
 * There is always an icon: an app that never set `icon` gets the placeholder,
 * because the AppImage step refuses to build without a square one.
 */
function generateIcons(config, { crateDir }) {
  const source =
    config.icon === undefined
      ? defaultIconPath()
      : path.resolve(crateDir, config.icon);
  if (!fs.existsSync(source)) {
    throw new Error(
      `desktop.json names an icon that does not exist: ${source}`,
    );
  }

  const iconDir = path.join(crateDir, 'build', 'icons');
  fs.mkdirSync(iconDir, { recursive: true });
  const target = path.join(iconDir, `icon@2x${path.extname(source)}`);
  if (path.resolve(source) !== path.resolve(target)) {
    fs.copyFileSync(source, target);
  }
  return [path.relative(crateDir, target).split(path.sep).join('/')];
}

/** The icon `desktop.json` names, or the CLI's placeholder. */
function appIconPath(projectRoot) {
  const { icon } = loadDesktopConfig(projectRoot, process.platform);
  const source =
    icon === undefined
      ? defaultIconPath()
      : path.resolve(projectRoot, 'desktop', icon);
  return fs.existsSync(source) ? source : defaultIconPath();
}

/// The square PNG bundled with the CLI, used when an app sets no icon.
function defaultIconPath() {
  return path.join(cliDir, '..', 'assets', 'default-icon.png');
}
