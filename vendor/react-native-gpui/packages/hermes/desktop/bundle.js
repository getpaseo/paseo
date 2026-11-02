const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

const PLATFORM_DIRECTORIES = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'win32-x64',
  'win32-arm64': 'win32-arm64',
};

function compilerPath() {
  const directory = PLATFORM_DIRECTORIES[`${process.platform}-${process.arch}`];
  if (!directory) {
    throw new Error(
      `@react-native-gpui/hermes has no compiler for ${process.platform}-${process.arch}`,
    );
  }
  const executable = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
  const candidate = path.join(PACKAGE_ROOT, 'bin', directory, executable);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `hermesc not found at ${candidate}. Install the compiler with ` +
        '`npm run fetch-binaries --workspace @react-native-gpui/hermes`.',
    );
  }
  return candidate;
}

module.exports = {
  // Hermes bytecode is not source, so the transform must emit the profile the
  // Hermes parser and optimizer expect.
  metroConfig: () => ({
    transformer: { unstable_transformProfile: 'hermes-stable' },
  }),

  bundleExtension: '.hbc',

  compile: ({ input, output, sourcemapInput, sourcemapOutput, dev }) => {
    // `-w` silences the undefined-variable warnings Hermes emits for a bundled
    // React Native runtime, and each one quotes the whole minified source line —
    // about 120 KB a time, 1.5-2 MB a build. That buried every CI log. React
    // Native's own release scripts compile with warnings off for the same
    // reason; `dev` builds keep them, because there the source is readable and a
    // warning can be acted on.
    const args = ['-emit-binary', '-out', output];
    if (!dev) args.push('-w', '-O');
    if (sourcemapInput) args.push('-source-map', sourcemapInput);
    if (sourcemapOutput) args.push('-output-source-map', sourcemapOutput);
    args.push(input);
    execFileSync(compilerPath(), args, { stdio: 'inherit' });
    return { output };
  },
};
