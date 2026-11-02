//! The cxx bridge is generated first: the C++ glue CMake compiles includes
//! its header.

use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Bumped whenever the shape of `.configure-inputs` changes, so an upgrade
/// forces exactly one reconfigure instead of leaving a stale build.
const STAMP_VERSION: &str = "3";

/// Environment variables the `cmake` and `cc` crates read while generating the
/// build system, and which they resolve through a target-prefixed name first.
/// The `cmake` crate (`cmake-0.1.58/src/lib.rs`) resolves these in
/// `getenv_target_os` as `<VAR>_<target>`, `<VAR>_<target with '-' and '.' as
/// '_'>`, then `TARGET_<VAR>`/`HOST_<VAR>`, then `<VAR>`; the `cc` crate
/// (`cc-1.5.1/src/lib.rs`, `target_envs`) resolves `CC`/`CXX`/flag variables the
/// same way. `configure_env_names` expands every base listed here to all those
/// forms.
const CONFIGURE_ENV_VAR_BASES: &[&str] = &[
    // Compilers and flags the generated project is handed.
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CMAKE_PREFIX_PATH",
    "CMAKE_GENERATOR",
    "CMAKE_TOOLCHAIN_FILE",
    // Programs the `cmake` crate may invoke.
    "CMAKE",
    "EMCMAKE",
    "EMMAKE",
    // Apple SDK selection (read by `cc`, then handed to CMake).
    "MACOSX_DEPLOYMENT_TARGET",
    "SDKROOT",
];

/// Cargo-provided variables the `cmake` crate reads directly at configure time
/// (`cmake-0.1.58/src/lib.rs` lines 134-170, 442-460). These have no useful
/// target-prefixed form, so only the plain name goes into the stamp.
const CONFIGURE_CARGO_VARS: &[&str] = &[
    "OPT_LEVEL",
    "DEBUG",
    "PROFILE",
    "HOST",
    "CARGO_CFG_TARGET_OS",
    "CARGO_CFG_TARGET_ARCH",
    "CARGO_CFG_TARGET_ENV",
];

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=build.rs");
    for var in [
        "RN_GPUI_PREBUILT_DIR",
        "RN_GPUI_BUILD_FROM_SOURCE",
        "RN_GPUI_PREBUILT_CACHE",
        "RN_GPUI_PREBUILT_OFFLINE",
        "CARGO_NET_OFFLINE",
        "GITHUB_TOKEN",
        "GH_TOKEN",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    watch_configure_envs();

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    watch_cpp_tree(&manifest_dir.join("cpp"));
    let react_gpui_dir = manifest_dir.parent().expect("ReactGpui dir").to_path_buf();
    let package_dir = react_gpui_dir
        .parent()
        .expect("the platform package dir")
        .to_path_buf();

    // Counting parent directories can only be right in one of the two layouts
    // this crate builds in: a repository checkout, or `node_modules` in an app.
    // Look the dependency up instead.
    let react_native_dir = find_node_module(&package_dir, "react-native").unwrap_or_else(|| {
        panic!(
            "react-native was not found in any node_modules at or above {}",
            package_dir.display()
        )
    });
    let react_common_dir = react_native_dir.join("ReactCommon");
    let react_cxx_platform_dir = package_dir.join("ReactCxxPlatform");
    // The app root: the directory that holds `node_modules`. Found from where
    // react-native was installed, which is the only anchor that holds in a
    // repository checkout and in an app alike.
    let node_modules_dir = react_native_dir
        .parent()
        .expect("react-native lives in a node_modules directory")
        .to_path_buf();
    let app_root = node_modules_dir
        .parent()
        .expect("node_modules has a parent directory")
        .to_path_buf();
    for changed_platform_source in [
        "react/io/ImageLoaderModule.cpp",
        "react/io/ImageLoaderModule.h",
        "react/runtime/ReactCxxTurboModuleProvider.cpp",
        "react/runtime/ReactCxxTurboModuleProvider.h",
        "react/runtime/ReactHost.cpp",
        "react/runtime/PlatformTimerRegistryImpl.cpp",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            react_cxx_platform_dir
                .join(changed_platform_source)
                .display()
        );
    }
    let overrides_dir = package_dir.join("ReactCommonOverrides");
    println!("cargo:rerun-if-changed={}", overrides_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set"));
    let target_triple = env::var("TARGET").expect("TARGET is set");
    let cargo_target_dir = cargo_target_dir(&out_dir, &target_triple);
    let cmake_build_type = cmake_build_type();
    let cmake_out_dir = cargo_target_dir
        .join("rn-gpui-cmake")
        .join(&target_triple)
        .join(cmake_build_type);

    let autolink_manifest = env::var_os("RN_GPUI_AUTOLINK_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_root.join("desktop/autolink/autolink.json"));
    // Generated sources live beside the CMake build tree instead of Cargo's
    // OUT_DIR. The OUT_DIR hash changes with the workspace and feature set, and
    // a changed include path would make CMake rebuild every C++ file.
    let prebuilt_dir = select_prebuilt_dir(
        &package_dir,
        &target_triple,
        &prebuilt_mode(&autolink_manifest),
    );
    // A prebuilt build keeps its own CMake directory. Sharing one with source
    // builds leaves their librn_gpui_core.a on the linker search path, where it
    // shadows the prebuilt archive and mixes two React Native ABIs.
    let cmake_out_dir = if prebuilt_dir.is_some() {
        cmake_out_dir.with_file_name(format!("{cmake_build_type}-prebuilt"))
    } else {
        cmake_out_dir
    };
    let generated_dir = cmake_out_dir.join("generated");
    let generated_rncore = generated_dir.join("fbreactnativespec");
    let generated_rncore_scratch = generated_dir.join("fbreactnativespec.tmp");
    let cxxbridge_include = generated_dir.join("cxxbridge-include");

    fs::create_dir_all(&cmake_out_dir).expect("create shared CMake output directory");
    // Two cargo invocations in one tree write the same generated directories
    // now, so the lock covers codegen as well as the CMake build.
    let cmake_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(cmake_out_dir.join(".configure-build.lock"))
        .expect("open shared CMake build lock");
    cmake_lock
        .lock()
        .expect("lock shared CMake build directory");

    let fb_spec_codegen = manifest_dir.join("scripts/generate-fbreactnativespec.cjs");
    println!("cargo:rerun-if-changed={}", fb_spec_codegen.display());
    println!(
        "cargo:rerun-if-changed={}",
        package_dir.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        react_native_dir.join("package.json").display()
    );
    watch_tree(&react_native_dir.join("src"));
    watch_tree(&react_native_dir.join("scripts/codegen"));
    // Usually a sibling of react-native; a hoisting package manager can put it
    // higher, which the lookup covers.
    let codegen_package = find_node_module(&package_dir, "@react-native/codegen")
        .unwrap_or_else(|| node_modules_dir.join("@react-native/codegen"));
    println!(
        "cargo:rerun-if-changed={}",
        codegen_package.join("package.json").display()
    );
    watch_tree(&codegen_package.join("lib"));
    // Codegen recreates its output directory, so generate into a scratch dir
    // and sync. Rewriting unchanged headers would recompile most of RN.
    let status = Command::new("node")
        .arg(&fb_spec_codegen)
        .arg(&react_native_dir)
        .arg(&generated_rncore_scratch)
        .status()
        .expect("run React Native core Codegen; Node.js must be installed");
    assert!(
        status.success(),
        "React Native FBReactNativeSpec Codegen failed"
    );
    sync_tree(&generated_rncore_scratch, &generated_rncore);

    // The app root: the directory that holds `node_modules`. When autolink ran
    // it named the manifest, whose location is the app's `desktop/autolink/`;
    // otherwise the `node_modules` that holds react-native is the anchor.
    let autolink_cmake = env::var_os("RN_GPUI_AUTOLINK_CMAKE")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_root.join("desktop/autolink/autolink.cmake"));
    let project_root = autolink_cmake
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or(&app_root)
        .to_path_buf();
    println!("cargo:rerun-if-env-changed=RN_GPUI_AUTOLINK_MANIFEST");
    println!("cargo:rerun-if-env-changed=RN_GPUI_AUTOLINK_CMAKE");
    println!("cargo:rerun-if-changed={}", autolink_cmake.display());
    // Autolinked CMake projects live outside this crate, so Cargo does not see
    // edits to them unless each directory is named here.
    for line in fs::read_to_string(&autolink_cmake)
        .unwrap_or_default()
        .lines()
    {
        if let Some(directory) = line
            .strip_prefix("add_subdirectory(\"")
            .and_then(|rest| rest.split('"').next())
        {
            println!("cargo:rerun-if-changed={directory}");
        }
    }
    let cpp_provider = autolink_cmake
        .parent()
        .unwrap_or(&autolink_cmake)
        .join("CppTurboModules.generated.cpp");
    println!("cargo:rerun-if-changed={}", cpp_provider.display());
    println!("cargo:rerun-if-changed={}", autolink_manifest.display());
    if let Ok(manifest) = fs::read_to_string(&autolink_manifest) {
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&manifest) {
            if let Some(modules) = manifest
                .get("cppTurboModules")
                .and_then(|value| value.as_array())
            {
                // The C++ sources, the specs and the headers generated from
                // them: a spec edit only reaches the build through its header.
                for key in ["sources", "specs", "headers"] {
                    for source in modules
                        .iter()
                        .filter_map(|module| module.get(key))
                        .filter_map(serde_json::Value::as_array)
                        .flatten()
                        .filter_map(serde_json::Value::as_str)
                    {
                        println!("cargo:rerun-if-changed={source}");
                    }
                }
            }
            if let Some(projects) = manifest
                .get("cmakeProjects")
                .and_then(|value| value.as_array())
            {
                for project in projects.iter().filter_map(serde_json::Value::as_str) {
                    println!(
                        "cargo:rerun-if-changed={}",
                        PathBuf::from(project).join("CMakeLists.txt").display()
                    );
                }
            }
            // The active engine's Node-API export list, if it ships one. On
            // Windows the app's executable has to re-export every Node-API
            // function, forwarded to the engine's DLL, because an addon's import
            // names the file it comes from and there is no global lookup. Only
            // the path and the library name travel here; generating the module
            // definition is the app build script's job, because linker arguments
            // for an executable only take effect from the crate that builds it.
            emit_node_api_exports(&manifest);
        }
    }
    cxx_build::bridge("src/lib.rs")
        .std("c++20")
        .include("cpp")
        .compile("rn_gpui_cxx_bridge");

    let cxxbridge_generated = out_dir.join("cxxbridge").join("include");
    assert!(
        cxxbridge_generated.join("rust").join("cxx.h").is_file(),
        "cxx_build did not produce {}",
        cxxbridge_generated.join("rust/cxx.h").display()
    );
    // cxx_build rewrites its headers every run (copies on Windows), so CMake
    // reads a mirror that only changes when the header contents do.
    sync_tree(&cxxbridge_generated, &cxxbridge_include);

    let mut defines: Vec<(&str, String)> = vec![
        ("REACT_COMMON_DIR", cmake_path(&react_common_dir)),
        (
            "REACT_CXX_PLATFORM_DIR",
            cmake_path(&react_cxx_platform_dir),
        ),
        ("RN_GPUI_OVERRIDES_DIR", cmake_path(&overrides_dir)),
        (
            "RN_GPUI_CXXBRIDGE_INCLUDE_DIR",
            cmake_path(&cxxbridge_include),
        ),
        (
            "RN_GPUI_GENERATED_RNCORE_DIR",
            cmake_path(&generated_rncore),
        ),
        ("RN_GPUI_PROJECT_ROOT", cmake_path(&project_root)),
        ("RN_GPUI_AUTOLINK_CMAKE", cmake_path(autolink_cmake)),
    ];
    // CMake deletes its cache when the compiler path changes, and the configure
    // it then re-runs has lost every -D argument and fails. Shells disagree on
    // the path (the /usr/bin shim or the Xcode toolchain binary behind it), so
    // name the shim unless the user chose a compiler.
    if cfg!(target_os = "macos") && target_triple.contains("apple") {
        for (variable, tool, env_name) in [
            ("CMAKE_C_COMPILER", "/usr/bin/cc", "CC"),
            ("CMAKE_CXX_COMPILER", "/usr/bin/c++", "CXX"),
        ] {
            println!("cargo:rerun-if-env-changed={env_name}");
            if env::var_os(env_name).is_none() {
                defines.push((variable, tool.to_string()));
            }
        }
    }
    // ccache for the C++ this build compiles. React Native's own
    // `ReactNative-application.cmake` sets the launcher for the app build, but
    // this crate configures CMake itself and never includes that file, so
    // without this the object cache is unused — CI measured 0 cacheable calls.
    if env::var_os("RN_GPUI_DISABLE_CCACHE").is_none() && ccache_available() {
        for variable in ["CMAKE_C_COMPILER_LAUNCHER", "CMAKE_CXX_COMPILER_LAUNCHER"] {
            defines.push((variable, "ccache".to_string()));
        }
    }
    if msvc_target() {
        // Rust always links the release CRT (msvcrt). CMake's Debug config
        // would compile with /MDd and the final link then fails on
        // _CrtDbgReport / _calloc_dbg, so pin every target, including
        // subprojects that declare an older cmake_minimum_required, to /MD.
        defines.push(("CMAKE_POLICY_DEFAULT_CMP0091", "NEW".to_string()));
        defines.push(("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreadedDLL".to_string()));
    }
    if let Some(dir) = &prebuilt_dir {
        defines.push(("RN_GPUI_PREBUILT_DIR", cmake_path(dir)));
        defines.push(("RN_GPUI_OVERRIDES_SHA256", overrides_sha256(&package_dir)));
    }

    // A configure rewrites flags.make, and every object depends on it, so
    // configuring on each build-script run would rebuild the whole C++ tree.
    // Configure only when the inputs changed; otherwise run the build, whose
    // own check still re-runs CMake when a CMakeLists or the cache changed.
    // `RN_GPUI_FORCE_CMAKE_CONFIGURE=1` is the escape hatch when the stamp
    // misses an input a future toolchain adds.
    let build_dir = cmake_out_dir.join("build");
    let stamp = configure_stamp(&defines, cmake_build_type, &target_triple);
    let stamp_path = cmake_out_dir.join(".configure-inputs");
    let generator_output_exists =
        build_dir.join("Makefile").is_file() || build_dir.join("build.ninja").is_file();
    let configure = env_flag("RN_GPUI_FORCE_CMAKE_CONFIGURE")
        || !fs::read_to_string(&stamp_path).is_ok_and(|previous| previous == stamp)
        || !build_dir.join("CMakeCache.txt").is_file()
        || !generator_output_exists;

    let dst = if configure {
        let mut cmake_config = cmake::Config::new("cpp");
        cmake_config
            .out_dir(&cmake_out_dir)
            .profile(cmake_build_type);
        for (name, value) in &defines {
            cmake_config.define(name, value);
        }
        // rn_gpui_modules links PUBLIC to rn_gpui_core, so this builds core too.
        let dst = cmake_config.build_target("rn_gpui_modules").build();
        fs::write(&stamp_path, &stamp).expect("write configure inputs stamp");
        dst
    } else {
        run_cmake_build(&build_dir, cmake_build_type);
        cmake_out_dir
    };
    drop(cmake_lock);

    let cmake_build_dir = dst.join("build");
    println!(
        "cargo:rustc-link-search=native={}",
        cmake_build_dir.display()
    );
    println!("cargo:rustc-link-lib=static:-bundle=rn_gpui_core");

    emit_link_libs(
        &cmake_manifest(&cmake_build_dir, "link_libs", cmake_build_type),
        &out_dir,
    );

    // Libraries with an `@rpath/...` install name cannot be found from
    // `rustc-link-search` alone, and `cargo:rustc-link-arg` from this package
    // would not reach the dependent binary. The directories are therefore
    // exported as `links` metadata (DEP_RN_GPUI_CORE_RPATHS) for the rn-gpui
    // package's build script, which turns them into linker rpath flags.
    emit_rpaths(&cmake_manifest(
        &cmake_build_dir,
        "rpath_dirs",
        cmake_build_type,
    ));

    match (
        env::var("CARGO_CFG_TARGET_OS").as_deref(),
        env::var("CARGO_CFG_TARGET_ENV").as_deref(),
    ) {
        (Ok("macos"), _) => println!("cargo:rustc-link-lib=c++"),
        (Ok("linux"), _) | (Ok("windows"), Ok("gnu")) => {
            println!("cargo:rustc-link-lib=stdc++")
        }
        _ => {}
    }
    // The static OpenSSL and curl archives call into the Windows cryptography
    // and event-log APIs without naming the import libraries (their `.drectve`
    // sections are written for a build that links through `nmake`, not through
    // CMake's imported targets). An *application* links these anyway because
    // its Rust dependency tree brings them in (`ring`, `reqwest`), so the gap
    // only shows up when a test binary links this crate on its own —
    // `LNK2019: unresolved external symbol __imp_CryptGenRandom`, and so on.
    // The CMake targets declare them (OpenSSL::Crypto's interface, `ws2_32` on
    // folly), but `emit_link_libs` only understands archives this build
    // produced, so the system libraries are named here.
    if msvc_target() {
        for library in [
            "crypt32", "advapi32", "userenv", "ws2_32", "bcrypt", "dbghelp",
        ] {
            println!("cargo:rustc-link-lib={library}");
        }
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        for framework in [
            "Foundation",
            "CoreFoundation",
            "CoreGraphics",
            "AppKit",
            "Metal",
            "QuartzCore",
            // libcurl reads the system proxy settings on macOS through
            // `SCDynamicStoreCopyProxies`. Nothing linked this framework until
            // the Rust HTTP stack was removed: reqwest had pulled it in
            // transitively, and without it the link fails on curl's macos.c.
            "SystemConfiguration",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}

fn sync_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create generated output directory");
    let mut seen = std::collections::HashSet::new();
    for entry in fs::read_dir(src).expect("read generated directory") {
        let entry = entry.expect("read generated entry");
        let name = entry.file_name();
        let from = entry.path();
        let to = dst.join(&name);
        seen.insert(name);
        // metadata() follows cxx_build's symlinks on Unix.
        if fs::metadata(&from).expect("stat generated entry").is_dir() {
            sync_tree(&from, &to);
            continue;
        }
        let bytes = fs::read(&from).expect("read generated file");
        if to.is_dir() {
            fs::remove_dir_all(&to).expect("replace generated directory");
        }
        if fs::read(&to).ok().as_deref() != Some(&bytes[..]) {
            fs::write(&to, &bytes).expect("write generated file");
        }
    }
    for entry in fs::read_dir(dst).expect("read generated mirror") {
        let entry = entry.expect("read generated mirror entry");
        if !seen.contains(&entry.file_name()) {
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path).expect("remove stale generated directory");
            } else {
                fs::remove_file(&path).expect("remove stale generated file");
            }
        }
    }
}

fn watch_tree(root: &Path) {
    if !root.is_dir() {
        return;
    }
    println!("cargo:rerun-if-changed={}", root.display());
    for entry in fs::read_dir(root).expect("read codegen input directory") {
        let path = entry.expect("read codegen input entry").path();
        if path.is_dir() {
            watch_tree(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn watch_cpp_tree(root: &Path) {
    if !root.is_dir() {
        return;
    }
    for entry in fs::read_dir(root).expect("read C++ source directory") {
        let path = entry.expect("read C++ source entry").path();
        if path.is_dir() {
            if matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("build" | "target")
            ) {
                continue;
            }
            watch_cpp_tree(&path);
            continue;
        }

        let is_source = matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" | "cmake")
        ) || path
            .file_name()
            .is_some_and(|name| name == "CMakeLists.txt");
        if is_source {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

/// Everything that changes what CMake configures. When it all matches the
/// previous run, the configure step is skipped: a reconfigure rewrites
/// `flags.make`, and make would then rebuild every object in the tree.
///
/// This only lists inputs the `cmake` crate reads. `cc` resolves the compiler
/// variables through `target_envs` (see `configure_env_names`), and the values
/// inside `cc`'s own cache depend on `OPT_LEVEL`/`DEBUG`, which Cargo rewrites
/// for the whole build, not just this crate.
fn configure_stamp(defines: &[(&str, String)], profile: &str, target: &str) -> String {
    let mut stamp = String::new();
    stamp.push_str("STAMP_VERSION=");
    stamp.push_str(STAMP_VERSION);
    stamp.push('\n');
    for (name, value) in defines {
        stamp.push_str(name);
        stamp.push('=');
        stamp.push_str(value);
        stamp.push('\n');
    }
    for name in configure_env_names(target) {
        stamp.push_str(&name);
        stamp.push('=');
        stamp.push_str(&env::var(name).unwrap_or_default());
        stamp.push('\n');
    }
    stamp.push_str("profile=");
    stamp.push_str(profile);
    stamp.push('\n');
    stamp.push_str("target=");
    stamp.push_str(target);
    stamp.push('\n');
    stamp.push_str("cmake_version=");
    stamp.push_str(&cmake_version());
    stamp.push('\n');
    stamp
}

/// Declares, once, every environment variable that `configure_stamp` reads, so
/// Cargo re-runs the build script when one changes. The target forms are
/// declared for every variable too: `configure_env_names` decides which one
/// actually lands in the stamp, but Cargo only needs to know that the script
/// depends on it.
fn watch_configure_envs() {
    println!("cargo:rerun-if-env-changed=RN_GPUI_FORCE_CMAKE_CONFIGURE");
    for name in configure_env_names(&env::var("TARGET").unwrap_or_default()) {
        println!("cargo:rerun-if-env-changed={name}");
    }
}

/// The environment variable names that can change a CMake configure: each base
/// name, plus the target-specific forms the `cmake` and `cc` crates resolve, in
/// the same order they try them (`cmake::Config::getenv_target_os`). Duplicates
/// are removed and the list is sorted so the stamp is stable.
fn configure_env_names(target: &str) -> Vec<String> {
    if target.is_empty() {
        return Vec::new();
    }
    // `cc` replaces both `-` and `.` with `_`.
    let target_underscored = target.replace(['-', '.'], "_");
    let kind = if target == env::var("HOST").unwrap_or_default() {
        "HOST"
    } else {
        "TARGET"
    };
    let mut names = Vec::new();
    for base in CONFIGURE_ENV_VAR_BASES {
        for name in [
            format!("{base}_{target}"),
            format!("{base}_{target_underscored}"),
            format!("{kind}_{base}"),
            (*base).to_string(),
        ] {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    for name in CONFIGURE_CARGO_VARS {
        let name = (*name).to_string();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort();
    names
}

/// The first line of `cmake --version`. A different CMake can accept or reject
/// different `-D` arguments, so it belongs in the stamp. Any failure yields an
/// empty string: version parsing never fails the build.
fn cmake_version() -> String {
    let executable = env::var("CMAKE").unwrap_or_else(|_| "cmake".to_string());
    Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Builds without configuring. CMake's own staleness check re-runs the
/// configure when a CMakeLists or the cache changed, so this is safe as long
/// as the configure inputs match `configure_stamp`.
fn run_cmake_build(build_dir: &Path, profile: &str) {
    let mut command = Command::new("cmake");
    command
        .arg("--build")
        .arg(build_dir)
        .arg("--target")
        .arg("rn_gpui_modules")
        .arg("--config")
        .arg(profile);
    if let Some(makeflags) = env::var_os("CARGO_MAKEFLAGS") {
        command.env("MAKEFLAGS", makeflags);
    } else if let Ok(jobs) = env::var("NUM_JOBS") {
        command.arg("--parallel").arg(jobs);
    }
    let status = command
        .status()
        .expect("run cmake --build; cmake must be on PATH");
    assert!(status.success(), "CMake build of rn_gpui_modules failed");
}

/// The app's `project.desktop.prebuilt` option (`auto`, `always` or `never`), which
/// autolink copies into its manifest. A missing manifest or field means `auto`.
fn prebuilt_mode(autolink_manifest: &Path) -> String {
    fs::read_to_string(autolink_manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|manifest| manifest.get("prebuilt")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "auto".to_string())
}

/// Order: `RN_GPUI_BUILD_FROM_SOURCE=1` or mode `never` -> source;
/// `RN_GPUI_PREBUILT_DIR` -> use it; otherwise `prebuilt-binaries.mjs ensure`
/// downloads (or reads the cache) the pinned runtime. The pin is used only
/// while the C++ inputs still hash to the pinned input hash, wherever this
/// package is installed. Any failure falls back to source with one warning,
/// and mode `always` turns that failure into a panic.
fn select_prebuilt_dir(package_dir: &Path, target: &str, mode: &str) -> Option<PathBuf> {
    let dir = select_prebuilt_dir_inner(package_dir, target, mode)?;
    match prebuilt_version(&dir) {
        Some(version) => {
            println!("cargo:warning=rn-gpui-sys: using prebuilt runtime {version} ({target})")
        }
        None => println!(
            "cargo:warning=rn-gpui-sys: using prebuilt runtime {} ({target})",
            dir.display()
        ),
    }
    Some(dir)
}
/// The archive's own version, so the build output and the CI report can name
/// the runtime that was linked instead of just its cache directory.
fn prebuilt_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    manifest
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

fn select_prebuilt_dir_inner(package_dir: &Path, target: &str, mode: &str) -> Option<PathBuf> {
    if env_flag("RN_GPUI_BUILD_FROM_SOURCE") || mode == "never" {
        return None;
    }
    let require = mode == "always";
    if let Some(dir) = env::var_os("RN_GPUI_PREBUILT_DIR") {
        let dir = PathBuf::from(dir);
        return match check_prebuilt_react_native(&dir, package_dir) {
            Ok(()) => Some(dir),
            Err(reason) => {
                fallback_or_panic(require, &reason);
                None
            }
        };
    }
    // Always compare the local C++ inputs with the pin, in a repository checkout
    // and under `node_modules` alike. A consumer whose own C++ inputs differ
    // must not link an archive those inputs did not build, and the hash is
    // computed from paths relative to this package, so it is the same value in
    // both layouts.
    if let Err(reason) = check_pinned_inputs(package_dir) {
        fallback_or_panic(require, &reason);
        return None;
    }

    let script = package_dir.join("scripts").join("prebuilt-binaries.mjs");
    let output = Command::new("node")
        .arg(&script)
        .arg("ensure")
        .arg("--triple")
        .arg(target)
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if dir.is_empty() {
                fallback_or_panic(require, "prebuilt-binaries.mjs printed no directory");
                return None;
            }
            let dir = PathBuf::from(dir);
            match check_prebuilt_react_native(&dir, package_dir) {
                Ok(()) => Some(dir),
                Err(reason) => {
                    fallback_or_panic(require, &reason);
                    None
                }
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            fallback_or_panic(
                require,
                &format!(
                    "prebuilt-binaries.mjs ensure exited {}: {stderr}",
                    out.status
                ),
            );
            None
        }
        Err(error) => {
            fallback_or_panic(require, &format!("could not run node: {error}"));
            None
        }
    }
}

/// The archive's ReactCommon and react-native headers come from the consumer's
/// own react-native install, so that install must be the version the archive
/// was built against. Compares manifest.json `reactNative` with the installed
/// react-native package.json `version`. Any mismatch (or unreadable input) is an
/// error, which the caller turns into a source fallback.
fn check_prebuilt_react_native(dir: &Path, package_dir: &Path) -> Result<(), String> {
    let manifest_path = dir.join("manifest.json");
    let manifest: serde_json::Value = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))
        .and_then(|text| {
            serde_json::from_str(&text)
                .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))
        })?;
    let built_for = manifest
        .get("reactNative")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("{} has no reactNative version", manifest_path.display()))?;

    let installed_pkg = find_node_module(package_dir, "react-native")
        .map(|dir| dir.join("package.json"))
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            "no react-native install found at or above the platform package".to_string()
        })?;
    let installed: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&installed_pkg)
            .map_err(|error| format!("cannot read {}: {error}", installed_pkg.display()))?,
    )
    .map_err(|error| format!("invalid {}: {error}", installed_pkg.display()))?;
    let installed_version = installed
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    if installed_version != built_for {
        return Err(format!(
            "prebuilt runtime was built for react-native {built_for}, installed react-native is {installed_version}"
        ));
    }
    Ok(())
}

/// A repository checkout may have C++ edits the pinned archive does not
/// contain, so its inputs must hash to the pin's `inputHash`.
fn check_pinned_inputs(package_dir: &Path) -> Result<(), String> {
    let pin_path = package_dir.join("prebuilt-binaries.json");
    println!("cargo:rerun-if-changed={}", pin_path.display());
    let pinned = fs::read_to_string(&pin_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|pin| pin.get("inputHash")?.as_str().map(str::to_owned))
        .ok_or_else(|| format!("{} has no inputHash", pin_path.display()))?;
    let output = Command::new("node")
        .arg(package_dir.join("scripts").join("prebuilt-inputs.mjs"))
        .output()
        .map_err(|error| format!("could not run node: {error}"))?;
    let local = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || local.is_empty() {
        return Err("prebuilt-inputs.mjs failed".to_string());
    }
    if local != pinned {
        return Err(format!(
            "local C++ inputs hash to {local}, the pinned prebuilt was built from {pinned}"
        ));
    }
    Ok(())
}

fn fallback_or_panic(require: bool, reason: &str) {
    if require {
        panic!(
            "rn-gpui-sys: project.desktop.prebuilt is 'always' and no prebuilt runtime: {reason}"
        );
    }
    println!("cargo:warning=rn-gpui-sys: no prebuilt runtime ({reason}); building from source");
}

fn env_flag(name: &str) -> bool {
    matches!(env::var(name).as_deref(), Ok("1") | Ok("true"))
}

fn overrides_sha256(package_dir: &Path) -> String {
    let output = Command::new("node")
        .arg(package_dir.join("scripts").join("prebuilt-inputs.mjs"))
        .arg("--overrides-sha256")
        .output()
        .expect("run node for overridesSha256");
    assert!(
        output.status.success(),
        "overridesSha256 failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn cmake_path(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

/// CMake writes these manifests per configuration because their content names
/// target file directories, and those differ between configurations on
/// multi-config generators (Visual Studio). Fall back to the unsuffixed name so
/// a build directory generated by an older layout still works.
fn cmake_manifest(cmake_build_dir: &Path, stem: &str, build_type: &str) -> PathBuf {
    let per_config = cmake_build_dir.join(format!("{stem}-{build_type}.txt"));
    if per_config.is_file() {
        return per_config;
    }
    cmake_build_dir.join(format!("{stem}.txt"))
}

fn emit_rpaths(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            println!(
                "cargo:warning=rn-gpui-sys: could not read {}: {error}",
                path.display()
            );
            return;
        }
    };

    let dirs: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if dirs.is_empty() {
        return;
    }
    println!("cargo:rpaths={}", dirs.join("|"));
}

/// The installed `<name>` package, found by walking up from `start` for a
/// `node_modules` directory that holds it.
///
/// A package's location must never be derived by counting parent directories:
/// this repository keeps its own packages at different depths (`packages/core`,
/// `modules/fonts`), while an app has every one of them in `node_modules`.
/// Walking up is the only rule that holds in both, and it also covers a package
/// hoisted to an ancestor `node_modules` by a workspace.
fn find_node_module(start: &Path, name: &str) -> Option<PathBuf> {
    for ancestor in start.ancestors() {
        let candidate = ancestor.join("node_modules").join(name);
        if candidate.join("package.json").is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Exports the active engine's Node-API export list as link metadata.
///
/// `cargo:node_api_exports` and `cargo:node_api_library` become
/// `DEP_RN_GPUI_CORE_NODE_API_EXPORTS` / `..._NODE_API_LIBRARY` for a dependent
/// `links = "rn_gpui_core"` crate. Nothing is emitted when the engine ships no
/// list (a platform with global symbol lookup, or an engine without Node-API),
/// which is how the app build script tells the two apart.
fn emit_node_api_exports(manifest: &serde_json::Value) {
    let Some(engine) = manifest
        .get("jsEngines")
        .and_then(|value| value.as_array())
        .and_then(|engines| engines.first())
    else {
        return;
    };
    let Some(exports) = engine.get("nodeApiExports").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(library) = engine.get("nodeApiLibrary").and_then(|v| v.as_str()) else {
        println!(
            "cargo:warning=rn-gpui-sys: the JS engine declares nodeApiExports without a nodeApiLibrary; Windows addons will not load"
        );
        return;
    };
    if !Path::new(exports).is_file() {
        println!(
            "cargo:warning=rn-gpui-sys: the JS engine's Node-API export list is missing: {exports}"
        );
        return;
    }
    println!("cargo:rerun-if-changed={exports}");
    println!("cargo:node_api_exports={exports}");
    println!("cargo:node_api_library={library}");
}

/// Whether a `ccache` binary is on `PATH`.
///
/// Only used to decide whether to hand CMake the compiler launcher: setting it
/// to a binary that is not there fails the configure, and a machine without
/// ccache has to build without it.
fn ccache_available() -> bool {
    let path = match env::var_os("PATH") {
        Some(path) => path,
        None => return false,
    };
    let exe = if cfg!(windows) {
        "ccache.exe"
    } else {
        "ccache"
    };
    env::split_paths(&path).any(|dir| dir.join(exe).is_file())
}

fn msvc_target() -> bool {
    matches!(std::env::var("CARGO_CFG_TARGET_ENV").as_deref(), Ok("msvc"))
}

/// Translates `link_libs.txt` (written by CMake) into cargo directives.
///
/// Line forms:
///  * `name:<file>`  — a library file name; `-l` takes it stripped of its
///    `lib` prefix and extension, `dylib=` for shared, `static=` for archives.
///  * `search:<dir>` — a directory to add to the link search path.
///
/// Off MSVC, third-party archives are linked through uniquely named symlinks
/// (`librngpui_ssl.a` for `libssl.a`). A crate that finds a system library
/// through pkg-config adds a directory such as `/usr/lib/x86_64-linux-gnu` to
/// the search path ahead of ours, and `-lssl` would then pick up the system's
/// static OpenSSL instead of the one this build's curl was compiled against.
fn emit_link_libs(path: &Path, out_dir: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            println!(
                "cargo:warning=rn-gpui-sys: could not read {}: {error}",
                path.display()
            );
            return;
        }
    };

    let link_dir = out_dir.join("rn-gpui-link");
    let mut seen = std::collections::HashSet::new();
    let mut last_search: Option<&str> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(dir) = line.strip_prefix("search:") {
            last_search = Some(dir);
            if seen.insert(format!("search:{dir}")) {
                println!("cargo:rustc-link-search=native={dir}");
            }
        } else if let Some(file) = line.strip_prefix("name:") {
            let file = Path::new(file);
            let stem = file
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            // link.exe only appends `.lib`, so on MSVC the `lib` prefix that
            // some libraries really carry (libcurl-d.lib, libssl.lib) must be
            // kept; stripping it fails with LNK1181.
            let stem = if msvc_target() {
                stem
            } else {
                stem.strip_prefix("lib").unwrap_or(stem)
            };
            let is_archive = stem.ends_with(".a") || stem.ends_with(".lib");
            let name = if is_archive {
                stem.trim_end_matches(".a").trim_end_matches(".lib")
            } else {
                stem.split('.').next().unwrap_or(stem)
            };
            if name.is_empty() {
                continue;
            }
            // The main archive is emitted before this transitive manifest so
            // Cargo does not see conflicting link modifiers for the same lib.
            if name == "rn_gpui_core" {
                continue;
            }
            let directive = if is_archive {
                let source = last_search.map(|dir| Path::new(dir).join(file));
                match source.and_then(|source| link_unique_archive(&link_dir, name, &source)) {
                    Some(unique) => {
                        if seen.insert(format!("search:{}", link_dir.display())) {
                            println!("cargo:rustc-link-search=native={}", link_dir.display());
                        }
                        format!("static:-bundle={unique}")
                    }
                    None => format!("static:-bundle={name}"),
                }
            } else {
                format!("dylib={name}")
            };
            if seen.insert(directive.clone()) {
                println!("cargo:rustc-link-lib={directive}");
            }
        } else {
            // A bare name is a static archive.
            let directive = format!("static:-bundle={line}");
            if seen.insert(directive.clone()) {
                println!("cargo:rustc-link-lib={directive}");
            }
        }
    }
}

/// Symlinks `source` into `link_dir` as `librngpui_<name>.a` and returns the
/// `-l` name to use. Returns `None` (link by the original name) on MSVC, for
/// this build's own `rn_gpui_*` archives, or when the archive is not found.
fn link_unique_archive(link_dir: &Path, name: &str, source: &Path) -> Option<String> {
    if msvc_target() || name.starts_with("rn_gpui") || !source.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        let unique = format!("rngpui_{name}");
        fs::create_dir_all(link_dir).ok()?;
        let link = link_dir.join(format!("lib{unique}.a"));
        if fs::read_link(&link).ok().as_deref() != Some(source) {
            let _ = fs::remove_file(&link);
            std::os::unix::fs::symlink(source, &link).ok()?;
        }
        Some(unique)
    }
    #[cfg(not(unix))]
    {
        let _ = link_dir;
        None
    }
}

fn cargo_target_dir(out_dir: &Path, target_triple: &str) -> PathBuf {
    if let Some(target_dir) = env::var_os("CARGO_TARGET_DIR") {
        let target_dir = PathBuf::from(target_dir);
        return if target_dir.is_absolute() {
            target_dir
        } else {
            env::current_dir()
                .expect("read build-script working directory")
                .join(target_dir)
        };
    }

    let profile = env::var("PROFILE").expect("PROFILE is set");
    let profile_dir = out_dir
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy() == profile)
        })
        .expect("find Cargo profile directory above OUT_DIR");
    let target_or_profile_dir = profile_dir
        .parent()
        .expect("Cargo profile directory has a parent");
    if target_or_profile_dir
        .file_name()
        .is_some_and(|name| name == target_triple)
    {
        target_or_profile_dir
            .parent()
            .expect("Cargo target triple directory has a parent")
            .to_path_buf()
    } else {
        target_or_profile_dir.to_path_buf()
    }
}

fn cmake_build_type() -> &'static str {
    match env::var("OPT_LEVEL").as_deref() {
        Ok("0") => "Debug",
        Ok("s" | "z") => "MinSizeRel",
        _ if env::var("DEBUG").as_deref() == Ok("false") => "Release",
        _ => "RelWithDebInfo",
    }
}
