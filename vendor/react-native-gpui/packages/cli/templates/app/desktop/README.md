# Desktop (GPUI)

This is the app-local GPUI target. Its `Cargo.toml` depends on the `react-native-gpui` Rust crate; `src/main.rs` is the app's launch point, so you can add Rust modules and local crate dependencies without editing the platform package. iOS, Android, and desktop share the JavaScript entry point and JS dependencies. The build script reads the app name and `desktop.appId` from the project-root `app.json`.

Run the desktop app from the project root with:

```sh
npx react-native run-desktop
```

The default reuses this project's Metro on port 8081, or starts it in a new
terminal window (`--terminal <app>` or `$REACT_TERMINAL` picks the terminal),
and runs a debug Cargo build, so Fast Refresh and LogBox work. Change the Metro
port with `--port 8082`; `--no-packager` never starts Metro, and
`--packager-log` runs it in the background with its output in
`desktop/build/metro.log`.
Use `--release` to bundle JavaScript and run the optimized, Metro-free build.

`npx react-native init-desktop` installs dependencies, autolinks native modules, and creates `build/index.bundle`; that bundle lets `cargo run` launch the latest initialized app without the CLI. For development with Fast Refresh, LogBox, and a live Metro server, use `npx react-native run-desktop`.

Autolink output is generated under `desktop/autolink/` and gitignored. It is
recreated by `init-desktop` and each `run-desktop`; do not commit those generated
files. Cargo build output and bundles are also kept under `desktop/build/`.

## Window configuration

`src/main.rs` uses `DesktopAppConfig` to set the title and initial size. It can
also set an initial position, configure public GPUI `WindowOptions`, install
GPUI app services before launch, and access the live `gpui::Window` after it
opens. Window size and position restore from the previous run by default; call
`.restore_window_state(false)` to always use the configured initial geometry.

## Project-local Rust TurboModules

A local Rust TurboModule is a spec file plus a `mod` that implements the trait
generated from it:

1. Add `src/NativeGreeting.ts` with a
   `TurboModuleRegistry.getEnforcing<Spec>('NativeGreeting')` spec.
2. List it in `desktop/build.rs`:
   `rn_gpui_module_build::generate(&["src/NativeGreeting.ts"]);`.
3. Write the implementation in `desktop/src/greeting.rs`, deriving nothing by
   hand: the generated file gives you `NativeGreetingSpec`, the events handle and
   the value structs.

   ```rust
   use rn_gpui_module::{ModuleError, ModuleThread, Value};

   pub struct Greeting;

   impl NativeGreetingSpec for Greeting {
       fn new(_events: NativeGreetingEvents) -> Self {
           Self
       }

       fn greet(&self, name: String) -> Result<String, ModuleError> {
           Ok(format!("Hello from Rust, {name}!"))
       }
   }
   ```

   A method that returns a value runs on the JS thread; a method that returns
   `void` or a `Promise` runs on the module's own thread unless the impl adds
   `const THREAD: ModuleThread = ModuleThread::Main;`.

4. Declare `mod greeting;` in `src/main.rs` and register it before the app
   starts:

   ```rust
   react_native_gpui::register_module(native_greeting_module::<greeting::Greeting>());
   ```

`include_specs!()` in `main.rs` pulls in the generated traits, structs and
descriptors. A mistake against the spec is a compile error in this crate, not a
runtime surprise. The runtime crate is `rn-gpui-module`, and
`rn-gpui-module-build` runs the generator from `build.rs`.

A Rust module depends on core and on gpui by **version**, never by path:

```toml
[dependencies]
rn-gpui-module = "0.1"
gpui = "0.2"

[build-dependencies]
rn-gpui-module-build = "0.1"
```

Those crates live inside `@react-native-gpui/core`, at a path that only exists
in this repository, so a relative path breaks the moment the package is
installed. Autolink reads core's `Cargo.toml` for the gpui revision and writes a
`[patch.crates-io]` table into the app's `desktop/Cargo.toml`, which is the only
place `[patch]` applies; that table points each crate at the core the app
actually installed and pins gpui to core's revision. It is regenerated on every
autolink run, so edit the version in your own manifest and leave the patch
alone. A path or git dependency on those crates is refused with an explanation
rather than failing later in an installed app.

For a reusable TurboModule library, keep its TypeScript spec under `src/` and
its native implementation under `desktop/`, with `codegenConfig` and
`platforms.desktop` in `package.json`; `npx react-native create-library` creates
that layout. Autolink runs React Native Codegen over the package's specs and
writes `<codegenConfig.name>JSI.h` plus `<codegenConfig.name>.h`, the latter
declaring one spec class per spec file (`src/NativeGreeting.ts` defines
`NativeGreetingSpec`). A C++ implementation derives from that class and
declares one method per spec method, with typed arguments (`std::string`,
`double`, `bool`, `folly::dynamic`, `std::vector<T>`, `std::optional<T>`,
`rngpui::Callback<...>`) and either a return value or, for a spec `Promise<T>`,
a `void` method taking `rngpui::Promise<T>` last. `react/bridging` performs the
conversion, so a signature that disagrees with the spec fails to compile.

Methods that return a value run on the JS thread and take `jsi::Runtime&`
first. Methods that return `void` or a `Promise` run on the module's own thread
by default, so they never block the JS thread; set
a `public static constexpr rngpui::ModuleThread kThread` to `Main` (the GPUI
main thread) or `JS` (inline on the JS thread, taking `jsi::Runtime&` first) to
choose another thread; the generated spec class reads `T::kThread`, so it has to
be public. A method that does not run on the JS thread cannot take
a JSI type. A spec `readonly onProgress: CodegenTypes.EventEmitter<number>`
generates a protected `emitOnProgress(value)` that any thread may call, and
`sendEvent("name", body)` covers modules used through `NativeEventEmitter`.

`desktop/desktop.json` is the app's own configuration: its name, identifier,
version, icon, window and how it is packaged. Its schema is
`@react-native-gpui/cli/desktop.schema.json`, so an editor completes it. A
`desktop.<os>.json` beside it is merged over the base for that OS. The
`Info.plist` is generated from these settings rather than hand-written, and
`npx react-native package-desktop` builds the installers from the same file.
