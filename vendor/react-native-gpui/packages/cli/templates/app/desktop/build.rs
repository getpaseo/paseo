fn main() {
    // Forwards the engine's Node-API exports out of this executable, which is
    // what lets a stock `.node` addon resolve them on Windows.
    //
    // A DLL records every import as a name *plus the file it comes from*, and a
    // node-gyp addon records "from `node.exe`" — Windows has no global symbol
    // scope for it to fall back on. Node's own answer is that the host process
    // exports the Node-API functions, so that is what this does: the executable
    // re-exports each of the VM's `napi_*`/`node_api_*` names, forwarded to
    // `hermesvm.dll`. Addons that use node-gyp's delay-load hook (the default)
    // then reach this process instead of looking for `node.exe` on disk.
    //
    // It is a no-op on macOS and Linux, where an addon's imports resolve against
    // whatever is already loaded and need no forwarding. Declare it once, before
    // the module list; it does not depend on anything else in this file.
    rn_gpui_module_build::forward_node_api_exports();

    // App-local Rust TurboModules: list one entry per `src/Native*.ts` spec,
    // for example `&["src/NativeGreeting.ts"]`. Their glue is generated into
    // this crate's OUT_DIR, and main.rs registers the modules.
    rn_gpui_module_build::generate(&[]);

    let desktop_root = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
    );
    // `app.json` names the app; `desktop/desktop.json` carries the identifier
    // and everything else the packaging step needs. The loader the CLI uses is
    // JavaScript, so this reads the same file directly and applies the two
    // defaults it would apply.
    let project_root = desktop_root
        .parent()
        .expect("desktop folder has a React Native project root");
    let app_json_path = project_root.join("app.json");
    println!("cargo:rerun-if-changed={}", app_json_path.display());
    let app_json: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&app_json_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", app_json_path.display())),
    )
    .unwrap_or_else(|error| panic!("parse {}: {error}", app_json_path.display()));
    let app_name = app_json["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .expect("app.json must define a nonempty name");
    if app_json["desktop"]
        .as_object()
        .is_some_and(|desktop| !desktop.is_empty())
    {
        panic!("move `app.json` desktop.* into `desktop/desktop.json` (see the README)");
    }

    let desktop_json_path = project_root.join("desktop/desktop.json");
    println!("cargo:rerun-if-changed={}", desktop_json_path.display());
    let desktop_json: serde_json::Value = std::fs::read(&desktop_json_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(serde_json::Value::Null);
    let app_id = match desktop_json["identifier"].as_str() {
        Some(identifier) if !identifier.is_empty() => identifier.to_string(),
        _ => format!(
            "com.example.{}",
            app_name
                .to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>()
        ),
    };
    println!("cargo:rustc-env=RN_GPUI_APP_NAME={app_name}");
    println!("cargo:rustc-env=RN_GPUI_APP_ID={app_id}");
    // Only a debug build names the bundle it was developed against. A release
    // binary must find the bundle beside its own executable, because the path
    // baked in here is where this machine happened to build it — and on the
    // machine the package is installed on, that path does not exist.
    println!("cargo:rerun-if-env-changed=PROFILE");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!(
            "cargo:rustc-env=RN_GPUI_DEFAULT_BUNDLE={}",
            desktop_root.join("build/index.bundle").display()
        );
    }

    println!("cargo:rerun-if-env-changed=DEP_RN_GPUI_RUNTIME_RPATHS");
    println!("cargo:rerun-if-env-changed=RN_GPUI_PACKAGING");
    let Ok(paths) = std::env::var("DEP_RN_GPUI_RUNTIME_RPATHS") else {
        return;
    };
    let dirs = paths.split('|').filter(|path| !path.is_empty());
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        stage_shared_libraries(dirs);
        return;
    }
    // `RN_GPUI_PACKAGING` means this binary is about to be installed somewhere
    // else, so only the relative rpaths belong in it. Keeping the absolute ones
    // would let a packaged app load this build tree's libraries in preference to
    // its own on the machine that built it — which hides exactly the packaging
    // bugs the packaged run exists to catch.
    let packaging = std::env::var("RN_GPUI_PACKAGING").is_ok();
    if !packaging {
        for path in dirs {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{path}");
        }
    }
    emit_relocatable_rpaths(app_name);
}

/// rpaths that survive being installed somewhere else.
///
/// The absolute paths above let a development build run from this tree. A
/// packaged app is copied to another machine, where those paths do not exist,
/// so a release build also carries paths relative to the executable: the
/// layout the installers produce.
fn emit_relocatable_rpaths(app_name: &str) {
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let mut emit = |rpath: String| println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
    match os.as_str() {
        // An app bundle puts the executable in Contents/MacOS and the shipped
        // libraries in Contents/Frameworks.
        "macos" => emit("@executable_path/../Frameworks".into()),
        // Linux installs the executable at `usr/bin` and ships its libraries
        // under `usr/lib`:
        // - the deb puts them in `usr/lib/<app>`;
        // - an AppImage's libraries are flat in `usr/lib`, because that is the
        //   directory AppRun puts on the library path and the one linuxdeploy
        //   resolves dependencies from before the image is assembled.
        // Both are covered, so one binary works in either layout.
        "linux" => {
            emit(format!("$ORIGIN/../lib/{app_name}"));
            emit("$ORIGIN/../lib".into());
            emit("$ORIGIN".into());
        }
        // Windows has no rpath: the DLLs are copied beside the executable.
        _ => {}
    }
}

/// Windows has no rpath: the loader finds a DLL next to the executable or on
/// `PATH`, so every directory the runtime reports as holding a shared library
/// (the Hermes binary directory in particular) is copied into the profile
/// directory that receives this app's executable. Without this the app builds
/// and then fails to start with "hermesvm.dll was not found".
fn stage_shared_libraries<'a>(dirs: impl Iterator<Item = &'a str>) {
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    // <profile>/build/<package>-<hash>/out -> <profile>
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let source = entry.path();
            let is_shared_library = source
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"));
            if !is_shared_library {
                continue;
            }
            let Some(name) = source.file_name() else {
                continue;
            };
            println!("cargo:rerun-if-changed={}", source.display());
            std::fs::copy(&source, profile_dir.join(name)).unwrap_or_else(|error| {
                panic!("copy {} next to the executable: {error}", source.display())
            });
        }
    }
}
