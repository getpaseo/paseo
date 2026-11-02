# Hermes patches

Patches carried on top of the pinned `facebook/hermes` commit
(`10a40b5f1de81d007cba6afe567c4ba7a0b45f5d`; see `hermes.commit` in
`package.json`).

Two of the local build scripts apply every `patches/*.patch` to the Hermes
checkout before configuring it, and skip a patch that is already applied:
`scripts/build-hermes-linux.sh` and `scripts/build-hermes-windows.ps1`. The
`hermes-engine` workflow does the same for every platform it builds, which is
what makes a binary fetched from it equivalent to one built locally.
`scripts/build-hermes-macos.sh` does **not** apply patches — neither patch
changes macOS, so it has nothing to do; if a future patch ever does, that script
has to be taught to apply it.

A patch that does not apply is an error rather than a warning in both scripts: a
silently unpatched build produces binaries that look right and fail at run time.

## 0001-linux-load-icu-at-runtime.patch

Hermes links the build machine's ICU into `libhermesvm.so`, and ICU puts its
major version in every file and symbol name, so the library only loads on
systems that have that exact ICU version (the published Linux binaries need
`libicuuc.so.74`, for example). The patch adds the CMake option
`HERMES_ICU_RUNTIME_LOAD` (Linux only; incompatible with
`HERMES_ENABLE_INTL=ON`) that drops the link and resolves the fifteen ICU
entry points Hermes uses with `dlopen`/`dlsym` at first use, trying
`libicui18n.so.100` down to `libicui18n.so.50`. Without any system ICU the
Unicode fallbacks (ASCII-only case mapping, code-unit collation, no-op
normalization, C-locale dates) keep the VM working. `HERMES_ICU_VERSION`
forces a single version, with `0` disabling loading entirely, so tests can
exercise the fallback.

Regenerate it from a Hermes worktree at the pinned commit:

```sh
git -C <hermes checkout> worktree add /tmp/hermes-patch 10a40b5f1d
cd /tmp/hermes-patch          # make the changes
git add -A
git diff --cached --binary 10a40b5f1d > /path/to/patches/0001-linux-load-icu-at-runtime.patch
```

## 0002-windows-load-node-api-modules.patch

At the pinned commit `hermes_napi_load_module` (`API/napi/hermes_napi.cpp`)
raises `TypeError("Loading native modules is not supported on Windows")` under
`#ifdef _WIN32`; the working implementation is in the `#else`, behind
`dlopen`/`dlsym`. So no Node-API addon could be loaded on Windows at all.

The patch gives `_WIN32` the same behaviour with the Win32 API: the UTF-8 path is
converted to UTF-16 and passed to `LoadLibraryExW` with
`LOAD_WITH_ALTERED_SEARCH_PATH` (so an addon that ships a sibling DLL finds it),
the entry point is looked up with `GetProcAddress`, and the deprecated
`napi_module_register` path is kept exactly as the `dlopen` branch has it. A
failure raises `Failed to load module: <reason>`, where `<reason>` is the
system's text for `GetLastError()` from `FormatMessageW` — that is the message
that tells a user an addon needs `uv_*` or was built without node-gyp's
delay-load hook. The library is never unloaded, matching the other branch.

It also has to hoist `InitFunc`/`initFunc` above the `#ifdef`. Upstream declares
them inside the `#else`, and the `#endif` sits _after_ the shared tail, so on
Windows the code that creates the exports object, calls the entry point and
returns was compiled out — the function fell off the end and returned whatever
was in the return register. That surfaced as `napi_invalid_arg` (status 1) with
no last-error set, for every addon, while a missing file correctly reported a
failure. MSVC warned about it (`C4715: not all control paths return a value`);
the warning was the bug.

Unlike 0001 this one is not behind an option: it is what makes the Windows
engine able to load addons at all.

Regenerate it the same way as 0001, from a worktree at the pinned commit.
