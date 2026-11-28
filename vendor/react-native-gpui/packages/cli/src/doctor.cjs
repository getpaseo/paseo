'use strict';

const { spawnSync } = require('node:child_process');

const MIN_NODE = [22, 13, 0];
const MIN_RUST = {
  version: [1, 98, 0],
  fix: 'rustup update stable; if this still reports an older version, another Rust installation comes first on PATH',
};

/** The libraries the app links on Linux, with each distribution's package. */
const LINUX_LIBRARIES = [
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

function installCommands(packages) {
  return Object.entries(packages)
    .map(([distribution, name]) => {
      const command =
        distribution === 'Arch'
          ? `sudo pacman -S ${name}`
          : `sudo ${distribution === 'Fedora' ? 'dnf' : 'apt'} install ${name}`;
      return `${distribution}: ${command}`;
    })
    .join(', ');
}

/** Runs a command and never throws: a missing binary is `ok: false`. */
function systemProbe() {
  return {
    run(command, args = []) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      return {
        ok: !result.error && result.status === 0,
        found: !result.error,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
      };
    },
    nodeVersion: process.versions.node,
  };
}

function firstLine(text) {
  return text.split(/\r?\n/u)[0].trim();
}

function versionIn(text) {
  return /\d+\.\d+(?:\.\d+)?/u.exec(text)?.[0];
}

function atLeast(version, minimum) {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] ?? 0;
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

/**
 * A check that passes when `command` runs, reporting the version it prints,
 * and, with `minimum`, when that version is at least `minimum.version`.
 */
function tool(label, command, args, fix, minimum) {
  return {
    label,
    check(probe) {
      const result = probe.run(command, args);
      if (!result.ok)
        return { ok: false, message: `${command} was not found`, fix };
      const version = versionIn(firstLine(result.stdout || result.stderr));
      if (minimum && !(version && atLeast(version, minimum.version)))
        return {
          ok: false,
          version,
          message: `${label} ${minimum.version.join('.')} or newer is required`,
          fix: minimum.fix,
        };
      return { ok: true, version };
    },
  };
}

const node = {
  label: 'Node.js',
  check(probe) {
    const version = probe.nodeVersion;
    if (atLeast(version, MIN_NODE)) return { ok: true, version };
    return {
      ok: false,
      version,
      message: `Node.js ${MIN_NODE.join('.')} or newer is required`,
      fix: 'Install the current Node.js LTS from https://nodejs.org',
    };
  },
};

const rustupFix = {
  darwin: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  linux: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  win32: 'winget install -e --id Rustlang.Rustup',
};

const cmakeFix = {
  darwin: 'brew install cmake',
  linux: 'Install the cmake package of your distribution',
  win32: 'winget install -e --id Kitware.CMake',
};

const CLT_PATH = '/Library/Developer/CommandLineTools';

const macosChecks = [
  {
    label: 'Xcode command line tools',
    check(probe) {
      const result = probe.run('xcode-select', ['-p']);
      if (!result.ok) {
        return {
          ok: false,
          message: 'the Xcode command line tools are not installed',
          fix: 'xcode-select --install',
        };
      }
      if (result.stdout.startsWith(CLT_PATH)) return { ok: true };
      const version = probe.run('xcodebuild', ['-version']);
      return { ok: true, version: versionIn(firstLine(version.stdout)) };
    },
  },
  {
    label: 'Xcode license',
    check(probe) {
      const selected = probe.run('xcode-select', ['-p']);
      if (!selected.ok || selected.stdout.startsWith(CLT_PATH))
        return { ok: true };
      if (probe.run('xcodebuild', ['-license', 'check']).ok)
        return { ok: true };
      return {
        ok: false,
        message: 'the Xcode license has not been accepted',
        fix: 'sudo xcodebuild -license accept',
      };
    },
  },
];

const windowsChecks = [
  {
    label: 'MSVC compiler',
    check(probe) {
      if (probe.run('where.exe', ['cl']).ok) return { ok: true };
      return {
        ok: false,
        message: 'cl.exe is not on PATH',
        fix: 'Run from a Developer PowerShell for VS 2022. If Visual Studio is missing: winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
      };
    },
  },
  {
    label: 'Strawberry Perl',
    check(probe) {
      const result = probe.run('perl', ['-e', 'print $^X']);
      if (!result.ok) {
        return {
          ok: false,
          message: 'perl was not found',
          fix: 'winget install -e --id StrawberryPerl.StrawberryPerl',
        };
      }
      if (!/strawberry/iu.test(result.stdout)) {
        return {
          ok: false,
          message: `perl resolves to ${result.stdout}, not to Strawberry Perl`,
          fix: "Move C:\\Strawberry\\perl\\bin above Git's usr\\bin in PATH",
        };
      }
      return { ok: true };
    },
  },
  tool(
    'NASM',
    'nasm',
    ['-v'],
    'winget install -e --id NASM.NASM, then add C:\\Program Files\\NASM to PATH',
  ),
  {
    label: 'Long paths',
    check(probe) {
      const result = probe.run('reg', [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
        '/v',
        'LongPathsEnabled',
      ]);
      if (/LongPathsEnabled\s+REG_DWORD\s+0x1\b/iu.test(result.stdout))
        return { ok: true };
      return {
        ok: false,
        message: 'long paths are not enabled',
        fix: 'From an administrator PowerShell: New-ItemProperty -Path HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force, then restart',
      };
    },
  },
];

const linuxChecks = [
  tool(
    'C++ compiler',
    'c++',
    ['--version'],
    'Install build-essential (Debian/Ubuntu), gcc-c++ (Fedora) or base-devel (Arch)',
  ),
  tool(
    'pkg-config',
    'pkg-config',
    ['--version'],
    'Debian/Ubuntu: sudo apt install pkg-config, Fedora: sudo dnf install pkgconf-pkg-config, Arch: sudo pacman -S pkgconf',
  ),
  tool(
    'Perl',
    'perl',
    ['-e', 'print "$^V"'],
    'Install the perl package of your distribution',
  ),
  ...LINUX_LIBRARIES.map(({ pc, packages }) => ({
    label: `${pc} development files`,
    check(probe) {
      const result = probe.run('pkg-config', ['--modversion', pc]);
      if (result.ok) return { ok: true, version: firstLine(result.stdout) };
      return {
        ok: false,
        message: result.found
          ? `pkg-config cannot find ${pc}`
          : 'pkg-config was not found',
        fix: installCommands(packages),
      };
    },
  })),
];

/** The checks for one platform (`process.platform` values), in report order. */
function desktopChecks(platform) {
  return [
    node,
    tool(
      'Rust',
      'rustc',
      ['--version'],
      rustupFix[platform] ?? rustupFix.linux,
      MIN_RUST,
    ),
    tool(
      'Cargo',
      'cargo',
      ['--version'],
      rustupFix[platform] ?? rustupFix.linux,
      MIN_RUST,
    ),
    tool('CMake', 'cmake', ['--version'], cmakeFix[platform] ?? cmakeFix.linux),
    ...(platform === 'darwin'
      ? macosChecks
      : platform === 'win32'
        ? windowsChecks
        : platform === 'linux'
          ? linuxChecks
          : []),
  ];
}

/** Runs every check for `platform` and returns the results in order. */
function runDoctor(platform = process.platform, probe = systemProbe()) {
  return desktopChecks(platform).map(({ label, check }) => ({
    label,
    ...check(probe),
  }));
}

function colors(enabled) {
  const wrap = (open, close) => text =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    red: wrap(31, 39),
    green: wrap(32, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** The report `doctor` prints. */
function formatReport(results, platform, color = false) {
  const c = colors(color);
  const lines = [
    c.bold(`Desktop development on ${platformNames[platform] ?? platform}`),
  ];
  for (const result of results) {
    if (result.ok) {
      lines.push(
        ` ${c.green('✓')} ${result.label}${result.version ? c.dim(` ${result.version}`) : ''}`,
      );
    } else {
      lines.push(` ${c.red('✖')} ${result.label}: ${result.message}`);
      if (result.fix) lines.push(`     ${c.dim('Fix:')} ${result.fix}`);
    }
  }
  const problems = results.filter(result => !result.ok).length;
  lines.push('');
  lines.push(
    problems === 0
      ? c.green('Everything needed to build a desktop app is installed.')
      : c.red(`${problems} ${problems === 1 ? 'problem' : 'problems'} found.`),
  );
  return lines.join('\n');
}

/** Prints the report and returns the process exit code. */
function doctor({
  platform = process.platform,
  probe,
  stream = process.stdout,
} = {}) {
  const results = runDoctor(platform, probe);
  const color = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  stream.write(`${formatReport(results, platform, color)}\n`);
  return results.every(result => result.ok) ? 0 : 1;
}

/** The same checks as a category for `npx react-native doctor`. */
function reactNativeHealthChecks(platform = process.platform) {
  return [
    {
      label: 'Desktop',
      healthchecks: desktopChecks(platform).map(({ label, check }) => {
        let last;
        return {
          label,
          getDiagnostics: async () => {
            last = check(systemProbe());
            return {
              needsToBeFixed: !last.ok,
              version: last.version,
              description: last.ok ? undefined : last.message,
            };
          },
          runAutomaticFix: async ({ loader, logManualInstallation }) => {
            loader.fail();
            logManualInstallation({ message: last?.fix ?? `Fix ${label}` });
          },
        };
      }),
    },
  ];
}

module.exports = {
  LINUX_LIBRARIES,
  desktopChecks,
  doctor,
  formatReport,
  installCommands,
  reactNativeHealthChecks,
  runDoctor,
};
