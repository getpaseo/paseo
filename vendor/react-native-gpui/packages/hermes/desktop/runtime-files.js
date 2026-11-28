const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

const PLATFORM_DIRECTORIES = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'win32-x64',
  'win32-arm64': 'win32-arm64',
};

const LIBRARY_NAMES = {
  darwin: 'libhermesvm.dylib',
  linux: 'libhermesvm.so',
  win32: 'hermesvm.dll',
};

// A release build links the VM without the debugger, under `release/`, and a
// debug build the one with it (see `CMakeLists.txt`).
module.exports = (platform, arch, { release = true } = {}) => {
  const directory = PLATFORM_DIRECTORIES[`${platform}-${arch}`];
  if (!directory) return [];
  const library = LIBRARY_NAMES[platform];
  if (!library) return [];
  const candidate = path.join(
    PACKAGE_ROOT,
    'bin',
    directory,
    ...(release ? ['release'] : []),
    library,
  );
  return fs.existsSync(candidate) ? [candidate] : [];
};
