# @react-native-gpui/hermes

The pinned [Hermes](https://github.com/facebook/hermes) engine for
react-native-gpui, packaged the way React Native ships its own engine: the
public headers we compile against, plus the prebuilt VM and `hermesc` compiler
for every platform we support.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Install

Apps created with `npx @react-native-gpui/cli init` already depend on it. In an existing app:

```sh
npm install @react-native-gpui/hermes
```

The engine binaries for your platform are downloaded from the matching GitHub release the first time the app is built.

The rest of this file describes how the package is built and maintained.

## Build

Everything here is built from one commit, recorded in `package.json`:

```json
"hermes": {
  "repository": "https://github.com/facebook/hermes",
  "commit": "10a40b5f1de81d007cba6afe567c4ba7a0b45f5d"
}
```

## Layout

| Path                           | Contents                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `API/`, `public/`, `include/`  | The upstream headers we compile against, byte for byte (below)  |
| `bin/<platform>-<arch>/`       | The prebuilt VMs and compiler (not committed; fetched or built) |
| `desktop/node-api-exports.txt` | Every `napi_*`/`node_api_*` name the VM exports, one per line   |
| `patches/`                     | Patches applied to the pinned commit before building            |
| `scripts/fetch-binaries.mjs`   | Downloads a CI artifact or release into `bin/` and verifies it  |

`desktop/node-api-exports.txt` lists the Node-API names the VM exports. On Windows
an addon cannot resolve those symbols from a global scope — a DLL import names
the file it comes from — so the app's executable re-exports each one, forwarded
to `hermesvm.dll`. The list is what that forwarding is generated from, and
`desktop/node-api-exports.test.js` regenerates it from the installed library and
fails when the two disagree. Regenerate it after a Hermes bump:

```sh
dumpbin /exports bin/win32-x64/hermesvm.dll | # keep the napi_* / node_api_* rows
```

Only the headers needed to compile against the VM are vendored. Everything
else in upstream `include/` is VM internals the shared library does not export.

- `API/{hermes,jsi,napi,hermes_abi}/**/*.h`: every upstream header in those
  folders (`hermes.h`, the debugger and CDP headers React Native's inspector
  uses, `hermes_napi.h`, JSI and the Hermes ABI). Sources and tooling under
  `API/` and the unused `API/hermes_sandbox` are not vendored.
- `public/hermes/Public/*.h`: config and export headers that `hermes.h`
  includes.
- `include/hermes/napi/`: the Node-API C headers that `hermes_napi.h`
  includes, with upstream's `VENDORED.md`.

The build compiles against React Native's JSI (`ReactCommon/jsi`); `API/jsi`
is kept only so the API folder matches upstream.

## Node-API addons

The engine owns the Node-API half of loading a stock `.node` file. The build
enables `HERMES_ENABLE_NAPI`, so the VM implements Node-API itself: `libhermesvm`
exports the `napi_*` and `node_api_*` symbols, and an addon links against
nothing — its imports resolve against whatever already loaded the VM.

`desktop/HermesNodeAddons.cpp` creates one Node-API environment per addon through
`hermes_napi_create_env` and loads the file with `hermes_napi_load_module`,
returning the exports as a JSI value. `desktop/HermesNodeApiHost.cpp` supplies the
host callbacks that environment needs: `post_work`, `cancel_work`, `post_task`
and `fatal_exception`. `post_task` and the async-work callbacks hop to the JS
thread through the `CallInvoker`, so core's `_requireNodeLibrary` global, path
resolution, per-runtime cache and error messages stay engine-agnostic.

A missing symbol in the addon surfaces as a `dlerror()` string, which is what
names an addon that needs libuv (`uv_default_loop`) rather than Node-API.

### Windows

Windows has no `dlopen` and no global symbol scope, so two things differ there
and both are handled by `patches/0002-windows-load-node-api-modules.patch`:

- the VM loads a `.node` file with `LoadLibraryExW` and `GetProcAddress` instead
  of `dlopen`/`dlsym`, converting the path to UTF-16 and using
  `LOAD_WITH_ALTERED_SEARCH_PATH` so an addon that ships a sibling DLL finds it;
- a failed load raises `Failed to load module: <reason>`, where `<reason>` is the
  system's text for `GetLastError()` from `FormatMessageW`. That is the message
  that tells a user an addon needs `uv_*`, or was built without node-gyp's
  delay-load hook (a missing `node.exe` import).

The patch also hoists `InitFunc`/`initFunc` above the `#ifdef`. Upstream declares
them inside the `#else` and closes the conditional _after_ the shared tail, so on
Windows the code creating the exports object, calling the entry point and
returning was compiled out; the function fell off the end and returned an
indeterminate value, which surfaced as `napi_invalid_arg` for every addon.

Unlike `0001` this patch is not behind an option: it is what makes the engine
able to load addons on Windows at all. `scripts/build-hermes-windows.ps1` applies
every patch in `patches/` before configuring, checking with `git apply --check`
first and reporting the ones it applied, so a build from a clean checkout always
matches the pinned commit plus these changes.

`bin/` is gitignored, so a fresh clone has the headers but no binaries:

| Platform                     | Files                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `darwin-arm64`, `darwin-x64` | `libhermesvm.dylib`, `hermesc`, `release/libhermesvm.dylib`                                   |
| `linux-x64`, `linux-arm64`   | `libhermesvm.so`, `hermesc`, `release/libhermesvm.so`                                         |
| `win32-x64`, `win32-arm64`   | `hermesvm.dll`, `hermesvm.lib`, `hermesc.exe`, `release/hermesvm.dll`, `release/hermesvm.lib` |

Each platform has two VMs. The one in the platform folder is built with the
debugger (`HERMES_ENABLE_DEBUGGER=ON`), and debug builds link it. The one under
`release/` is built without it, and release builds link that one: it is smaller,
and keeps no debugger state, which with the debugger compiled in included the
compiler state of every `eval` (about 22 MB in an app whose worklets are made
with `eval`). The choice follows React Native's Hermes glue, which compiles its
debugger support for a `Debug` CMake build or with `REACT_NATIVE_DEBUG_OPTIMIZED`,
so the VM and the code driving it always agree. Both are optimized builds.

## Fetching the binaries

```sh
# latest successful hermes-engine workflow run (needs an authenticated gh)
npm run fetch-binaries

# a specific run, a release tag, or an artifact you downloaded by hand
node scripts/fetch-binaries.mjs --run 123456789
node scripts/fetch-binaries.mjs --tag hermes-10a40b5
node scripts/fetch-binaries.mjs --from ~/Downloads/hermes-darwin-arm64.zip

# check what is present: the host platform, or every platform
npm run verify-binaries
node scripts/fetch-binaries.mjs --verify --all
```

A fetched binary is built from the pinned commit **plus every patch in
`patches/`**: the workflow applies them before configuring. The local scripts do
the same, so the two agree.

## Building it yourself

`.github/workflows/hermes-engine.yml` builds all six targets and uploads one
artifact per platform. The same builds run locally through the repo scripts:

```sh
scripts/build-hermes-macos.sh      # builds universal, then lipo -thin per arch
scripts/build-hermes-linux.sh      # linux-x64
scripts/build-hermes-windows.ps1   # win32-x64, run from a Developer PowerShell
```

Each script expects a facebook/hermes checkout at the pinned commit (override
with `RN_GPUI_HERMES_SOURCE_DIR`) and warns when its HEAD does not match.

The build flags are mirrored from `package.json`'s `hermes.buildFlags`:

```
HERMES_ENABLE_NAPI=ON
HERMES_ENABLE_DEBUGGER=ON
HERMES_ENABLE_INTL=ON
HERMES_ICU_RUNTIME_LOAD=ON
HERMES_ICU_HEADERS_DIR=packages/hermes/third_party/icu
HERMES_ENABLE_TEST_SUITE=OFF
HERMES_BUILD_APPLE_FRAMEWORK=OFF
```

### Intl

`HERMES_ENABLE_INTL=ON` exposes `Intl.Collator`, `Intl.NumberFormat` and
`Intl.DateTimeFormat` (plus `Intl.getCanonicalLocales`, `formatToParts`, and the
`toLocale*` / `localeCompare` prototype methods). The pinned Hermes has no
`Intl.PluralRules`, `ListFormat`, `RelativeTimeFormat` or `Segmenter`.

Every platform uses one backend (`patches/0003-intl-on-the-system-icu.patch`)
written against ICU's C API, with ICU loaded when it is first needed, so the
engine ships no ICU data and links no ICU:

| Platform | ICU it loads                                              | Minimum                  |
| -------- | --------------------------------------------------------- | ------------------------ |
| macOS    | `/usr/lib/libicucore.A.dylib`                             | the ICU of the OS (64+)  |
| Windows  | `icu.dll` from System32                                   | Windows 10 1903 (ICU 64) |
| Linux    | `libicui18n.so.N`, N from 100 down to 64, with `libicuuc` | ICU 64                   |

`RN_GPUI_ICU_VERSION` forces one Linux version, and `0` turns loading off so
the fallback can be tested. With no usable ICU the VM still starts: it logs one
warning, `Intl` stays defined, numbers format as plain JavaScript numbers,
dates as ISO 8601 in UTC, strings compare by code unit, and case mapping covers
ASCII only.

The ICU headers it compiles against are vendored in `third_party/icu` (ICU 76.1,
unmodified, for signatures only). The backend calls only functions that ICU 64
has; `uloc_openAvailableByType` and `ucal_getCanonicalTimeZoneID` are optional.
`NumberFormat` builds an ICU number skeleton from the resolved options and
formats with `unumf_*`, so style (decimal, currency, percent, unit), digits,
grouping, compact and scientific notation, `signDisplay`, `roundingMode` and
`trailingZeroDisplay` come from ICU itself.

`scripts/intl-smoke.js` holds the assertions the `hermes-engine` workflow runs
on every platform, and on Linux against ICU 70, ICU 74 and no ICU.

## License

MIT. See [LICENSE](LICENSE). Hermes is MIT-licensed by Meta Platforms, Inc.
