//! The cxx bridge is generated first: the C++ glue CMake compiles includes
//! its header.

use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Bumped whenever the shape of `.configure-inputs` changes, so an upgrade
/// forces exactly one reconfigure instead of leaving a stale build.
const STAMP_VERSION: &str = "4";

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
        "RN_GPUI_NATIVE_DEPS_CACHE",
        "XDG_CACHE_HOME",
        "LOCALAPPDATA",
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
    watch_cpp_tree(&manifest_dir.join("cpp"), &[]);
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
        "react/io/WebSocketModule.cpp",
        "react/io/WebSocketModule.h",
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
    // Tests and the Android/iOS/JNI platform code here are never compiled.
    watch_cpp_tree(
        &react_cxx_platform_dir,
        &["tests", "__tests__", "android", "ios", "jni"],
    );
    let overrides_dir = package_dir.join("ReactCommonOverrides");
    println!("cargo:rerun-if-changed={}", overrides_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set"));
    let target_triple = env::var("TARGET").expect("TARGET is set");
    let cargo_target_dir = cargo_target_dir(&out_dir, &target_triple);
    let cmake_build_type = cmake_build_type();
    let cmake_out_dir = cargo_target_dir
        .join("rn-gpui-cmake")
        .join(cmake_triple_dir(&target_triple))
        .join(cmake_build_type);

    let autolink_manifest = env::var_os("RN_GPUI_AUTOLINK_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_root.join("desktop/autolink/autolink.json"));
    // The renderer is chosen in desktop/desktop.json and recorded by autolink,
    // together with the React Native tree its C++ and codegen read.
    let renderer = RendererSelection::read(&autolink_manifest);
    // Fixed at build time, as Loom's other platforms do. A different value
    // rebuilds Rust only; the C++ is the same for both.
    println!(
        "cargo:rustc-env=RN_GPUI_JS_THREAD_BUILT={}",
        if renderer.js_thread.is_empty() {
            "background"
        } else {
            &renderer.js_thread
        }
    );
    let react_native_dir = match &renderer.react_native_dir {
        Some(dir) if renderer.loom => {
            assert!(
                dir.join("package.json").is_file(),
                "the loom renderer's React Native tree {} does not exist; run `npx react-native-gpui autolink`",
                dir.display()
            );
            println!(
                "cargo:rerun-if-changed={}",
                dir.join(".loom-stamp.json").display()
            );
            dir.clone()
        }
        _ => react_native_dir,
    };
    let react_common_dir = react_native_dir.join("ReactCommon");
    // Generated sources live beside the CMake build tree instead of Cargo's
    // OUT_DIR. The OUT_DIR hash changes with the workspace and feature set, and
    // a changed include path would make CMake rebuild every C++ file.
    let renderer_name = if renderer.loom { "loom" } else { "fabric" };
    let prebuilt_dir = select_prebuilt_dir(
        &package_dir,
        &target_triple,
        &prebuilt_mode(&autolink_manifest),
        renderer_name,
    );
    // A prebuilt build keeps its own CMake directory. Sharing one with source
    // builds leaves their librn_gpui_core.a on the linker search path, where it
    // shadows the prebuilt archive and mixes two React Native ABIs.
    let cmake_out_dir = if prebuilt_dir.is_some() {
        let suffix = if renderer.loom {
            "loom-prebuilt"
        } else {
            "prebuilt"
        };
        cmake_out_dir.with_file_name(format!("{cmake_build_type}-{suffix}"))
    } else if renderer.loom {
        // Loom's headers change the layout of React Native's classes, so a
        // Loom build and a Fabric build must not share objects.
        cmake_out_dir.with_file_name(format!("{cmake_build_type}-loom"))
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
    // Usually a sibling of react-native; a hoisting package manager can put it
    // higher, which the lookup covers.
    let codegen_package = find_node_module(&package_dir, "@react-native/codegen")
        .unwrap_or_else(|| node_modules_dir.join("@react-native/codegen"));
    println!(
        "cargo:rerun-if-changed={}",
        codegen_package.join("package.json").display()
    );
    let codegen_inputs = fb_spec_codegen_inputs(
        &fb_spec_codegen,
        &package_dir,
        &react_native_dir,
        &codegen_package,
    );
    for (_, file) in &codegen_inputs {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    // The codegen takes seconds and its inputs only change with a React Native
    // or codegen upgrade, so it runs when their contents changed. The digest
    // names files relative to their package, so a copied target dir in another
    // checkout still matches.
    let codegen_stamp = generated_dir.join(".fbreactnativespec-inputs");
    let codegen_inputs_digest = files_digest(&codegen_inputs);
    if !generated_rncore.is_dir()
        || !fs::read_to_string(&codegen_stamp).is_ok_and(|stamp| stamp == codegen_inputs_digest)
    {
        // Codegen recreates its output directory, so generate into a scratch
        // dir and sync. Rewriting unchanged headers would recompile most of RN.
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
        fs::write(&codegen_stamp, &codegen_inputs_digest).expect("write codegen inputs stamp");
    }

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
    watch_generated_file(&autolink_cmake);
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
    // The C++ the app contributes: the sources and the headers it includes,
    // among them the host component glue autolink generates.
    for line in fs::read_to_string(&autolink_cmake)
        .unwrap_or_default()
        .lines()
    {
        let sources = line.contains("RN_GPUI_APP_CPP_SOURCES");
        let includes = line.contains("RN_GPUI_APP_CPP_INCLUDE_DIRS");
        if !sources && !includes {
            continue;
        }
        for quoted in line.split('"').skip(1).step_by(2) {
            let path = PathBuf::from(quoted);
            if sources {
                println!("cargo:rerun-if-changed={}", path.display());
            } else {
                watch_cpp_tree(&path, &[]);
            }
        }
    }
    let cpp_provider = autolink_cmake
        .parent()
        .unwrap_or(&autolink_cmake)
        .join("CppTurboModules.generated.cpp");
    watch_generated_file(&cpp_provider);
    watch_generated_file(&autolink_manifest);
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
    // ccache for the C++ this build compiles. React Native's own
    // `ReactNative-application.cmake` sets the launcher for the app build, but
    // this crate configures CMake itself and never includes that file, so
    // without this the object cache is unused — CI measured 0 cacheable calls.
    let use_ccache = env::var_os("RN_GPUI_DISABLE_CCACHE").is_none() && ccache_available();
    let mut prefix_map_flags = Vec::new();
    if use_ccache {
        // ccache only hits across checkouts when neither the command line nor
        // the object names the checkout's path.
        let source_roots = [&package_dir, &app_root, &project_root].map(PathBuf::as_path);
        if !msvc_target() {
            prefix_map_flags =
                prefix_map_flags_for(common_ancestor(&source_roots).as_deref(), &cmake_out_dir);
        }
        configure_ccache_env(
            canonical_common_ancestor(&source_roots).as_deref(),
            &cmake_out_dir,
        );
    }

    let mut cxx_bridge = cxx_build::bridge("src/lib.rs");
    cxx_bridge.std("c++20").include("cpp");
    // The bridge compiles on every run of this script, so it goes through
    // ccache too, with its sources in OUT_DIR mapped like the CMake build's.
    let bridge_ccache_var = if use_ccache && !msvc_target() {
        for flag in &prefix_map_flags {
            cxx_bridge.flag(flag);
        }
        // Last, as OUT_DIR can sit inside the checkout.
        let out_dir_path = cmake_path(&out_dir);
        if !prefix_map_flags.is_empty() && !out_dir_path.contains(char::is_whitespace) {
            cxx_bridge.flag(format!("-ffile-prefix-map={out_dir_path}=/rn-gpui/out"));
        }
        cxx_bridge.try_get_compiler().ok().and_then(|compiler| {
            // A wrapper already in place (sccache through RUSTC_WRAPPER) stays.
            let wrapped = compiler.to_command().get_program() != compiler.path().as_os_str();
            (!wrapped)
                .then(|| launch_bridge_through_ccache(compiler.path(), &target_triple))
                .flatten()
        })
    } else {
        None
    };
    cxx_bridge.compile("rn_gpui_cxx_bridge");
    if let Some(variable) = bridge_ccache_var {
        // The `cmake` crate reads the same variable to pick its compiler.
        env::remove_var(variable);
    }

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
        ("RN_GPUI_AUTOLINK_CMAKE", cmake_path(autolink_cmake.clone())),
        (
            "RN_GPUI_NATIVE_DEPS_CACHE",
            cmake_path(native_deps_cache_dir(&cargo_target_dir)),
        ),
    ];
    if renderer.loom {
        defines.push(("RN_GPUI_REACT_NATIVE_DIR", cmake_path(&react_native_dir)));
        defines.push(("LOOM_RENDERER", "1".to_string()));
    }
    let codegen_digest = autolink_codegen_digest(
        &autolink_cmake
            .parent()
            .unwrap_or(&autolink_cmake)
            .join("codegen"),
    );
    // CMake deletes its cache when the compiler path changes, and the configure
    // it then re-runs has lost every -D argument and fails. Shells disagree on
    // the path (the /usr/bin shim or the Xcode toolchain binary behind it), so
    // name the shim unless the user chose a compiler.
    if cfg!(target_os = "macos") && target_triple.contains("apple") {
        // CMake otherwise defaults to the installed SDK, independently of
        // Cargo's deployment target (including when reusing its cache).
        if let Ok(minimum) = env::var("MACOSX_DEPLOYMENT_TARGET") {
            defines.push(("CMAKE_OSX_DEPLOYMENT_TARGET", minimum));
        }
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
    if use_ccache {
        for variable in ["CMAKE_C_COMPILER_LAUNCHER", "CMAKE_CXX_COMPILER_LAUNCHER"] {
            defines.push((variable, "ccache".to_string()));
        }
        // The `cmake` crate hands C and C++ flags over, but not Objective-C++
        // ones (the `.mm` sources on macOS).
        if target_triple.contains("apple") && !prefix_map_flags.is_empty() {
            let mut objcxx_flags = env::var("OBJCXXFLAGS").unwrap_or_default();
            for flag in &prefix_map_flags {
                objcxx_flags.push(' ');
                objcxx_flags.push_str(flag);
            }
            defines.push(("CMAKE_OBJCXX_FLAGS", objcxx_flags.trim().to_string()));
        }
    }
    let generator = cmake_generator(use_ccache);
    if msvc_target() {
        // Rust always links the release CRT (msvcrt). CMake's Debug config
        // would compile with /MDd and the final link then fails on
        // _CrtDbgReport / _calloc_dbg, so pin every target, including
        // subprojects that declare an older cmake_minimum_required, to /MD.
        defines.push(("CMAKE_POLICY_DEFAULT_CMP0091", "NEW".to_string()));
        defines.push(("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreadedDLL".to_string()));
        // ccache cannot cache /Zi (the compiler writes a shared PDB), so embed
        // the debug info in each object (/Z7), in every subproject too.
        defines.push(("CMAKE_POLICY_DEFAULT_CMP0141", "NEW".to_string()));
        defines.push((
            "CMAKE_MSVC_DEBUG_INFORMATION_FORMAT",
            "$<$<CONFIG:Debug,RelWithDebInfo>:Embedded>".to_string(),
        ));
    }
    if let Some(dir) = &prebuilt_dir {
        defines.push(("RN_GPUI_PREBUILT_DIR", cmake_path(dir)));
        // find_package caches the directory it found, so a new pin would
        // otherwise keep linking the previous runtime.
        defines.push((
            "react-native-gpui-prebuilt_DIR",
            cmake_path(&dir.join("cmake")),
        ));
        defines.push((
            "RN_GPUI_OVERRIDES_SHA256",
            overrides_sha256(&package_dir, renderer_name),
        ));
    }

    // A configure rewrites flags.make, and every object depends on it, so
    // configuring on each build-script run would rebuild the whole C++ tree.
    // Configure only when the inputs changed; otherwise run the build, whose
    // own check still re-runs CMake when a CMakeLists or the cache changed.
    // `RN_GPUI_FORCE_CMAKE_CONFIGURE=1` is the escape hatch when the stamp
    // misses an input a future toolchain adds.
    let build_dir = cmake_out_dir.join("build");
    let stamp = configure_stamp(
        &defines,
        cmake_build_type,
        &target_triple,
        &codegen_digest,
        generator.unwrap_or_default(),
        &prefix_map_flags,
    );
    let stamp_path = cmake_out_dir.join(".configure-inputs");
    // The Visual Studio generators (MSVC's default) write `ALL_BUILD.vcxproj`
    // rather than a Makefile; without it here every MSVC build reconfigured, and
    // a configure that hands CMake other `cc` flags rebuilt all of the C++.
    let generator_output_exists = build_dir.join("Makefile").is_file()
        || build_dir.join("build.ninja").is_file()
        || build_dir.join("ALL_BUILD.vcxproj").is_file();
    let configure = env_flag("RN_GPUI_FORCE_CMAKE_CONFIGURE")
        || !fs::read_to_string(&stamp_path).is_ok_and(|previous| previous == stamp)
        || !build_dir.join("CMakeCache.txt").is_file()
        || !generator_output_exists;

    let dst = if configure {
        let source_dir = manifest_dir.join("cpp");
        reuse_build_dir(&build_dir, &source_dir, generator);
        let mut cmake_config = cmake::Config::new(&source_dir);
        cmake_config
            .out_dir(&cmake_out_dir)
            .profile(cmake_build_type);
        if let Some(generator) = generator {
            cmake_config.generator(generator);
        }
        for flag in &prefix_map_flags {
            cmake_config.cflag(flag).cxxflag(flag);
        }
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

    let link_libs = cmake_manifest(&cmake_build_dir, "link_libs", cmake_build_type);
    emit_link_libs(&link_libs, &out_dir);

    // Libraries with an `@rpath/...` install name cannot be found from
    // `rustc-link-search` alone, and `cargo:rustc-link-arg` from this package
    // would not reach the dependent binary. The directories are therefore
    // exported as `links` metadata (DEP_RN_GPUI_CORE_RPATHS) for the rn-gpui
    // package's build script, which turns them into linker rpath flags.
    let rpath_dirs = cmake_manifest(&cmake_build_dir, "rpath_dirs", cmake_build_type);
    emit_rpaths(&rpath_dirs);
    // The CMake build above rewrites these when they change, which made Cargo
    // re-run this script on the next build. Dated back to when Cargo started
    // this run, the write is not taken for a change, and a later one still is.
    if let Some(invoked) = out_dir
        .parent()
        .and_then(|dir| fs::metadata(dir.join("invoked.timestamp")).ok())
        .and_then(|metadata| metadata.modified().ok())
    {
        for manifest in [&link_libs, &rpath_dirs] {
            if fs::metadata(manifest)
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| modified > invoked)
            {
                if let Ok(file) = OpenOptions::new().write(true).open(manifest) {
                    let _ = file.set_modified(invoked);
                }
            }
        }
    }

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

/// What `renderer` in `desktop/desktop.json` selected, as autolink recorded it.
struct RendererSelection {
    loom: bool,
    js_thread: String,
    react_native_dir: Option<PathBuf>,
}

impl RendererSelection {
    fn read(autolink_manifest: &Path) -> Self {
        let renderer = fs::read_to_string(autolink_manifest)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|manifest| manifest.get("renderer").cloned());
        let text = |key: &str| {
            renderer
                .as_ref()
                .and_then(|renderer| renderer.get(key))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        Self {
            loom: text("name").as_deref() == Some("loom"),
            js_thread: text("jsThread").unwrap_or_default(),
            react_native_dir: text("reactNativeDir").map(PathBuf::from),
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

/// The files FBReactNativeSpec codegen reads, each with a name relative to its
/// package: the generator script and the pins it checks, the spec files in
/// react-native's `src` (codegen's own filter, `filterJSFile` in
/// `@react-native/codegen/lib/cli/combine/combine-utils.js`, widened to every
/// platform suffix), and the JavaScript of react-native's codegen scripts and
/// of `@react-native/codegen`.
fn fb_spec_codegen_inputs(
    script: &Path,
    package_dir: &Path,
    react_native_dir: &Path,
    codegen_package: &Path,
) -> Vec<(String, PathBuf)> {
    let mut inputs = vec![
        ("script".to_string(), script.to_path_buf()),
        (
            "core/package.json".to_string(),
            package_dir.join("package.json"),
        ),
        (
            "react-native/package.json".to_string(),
            react_native_dir.join("package.json"),
        ),
        (
            "codegen/package.json".to_string(),
            codegen_package.join("package.json"),
        ),
    ];
    let is_js = |path: &Path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        !name.ends_with(".d.ts")
            && matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("js" | "ts" | "tsx")
            )
    };
    let is_spec = |path: &Path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        is_js(path) && (name.starts_with("Native") || name.contains("NativeComponent"))
    };
    for (label, root, filter) in [
        (
            "react-native",
            react_native_dir.join("src"),
            &is_spec as &dyn Fn(&Path) -> bool,
        ),
        (
            "react-native",
            react_native_dir.join("scripts/codegen"),
            &is_js,
        ),
        ("codegen", codegen_package.join("lib"), &is_js),
    ] {
        let mut files = Vec::new();
        collect_files(&root, filter, &mut files);
        files.sort();
        let base = root.parent().unwrap_or(&root);
        for file in files {
            let relative = file.strip_prefix(base).unwrap_or(&file);
            inputs.push((
                format!("{label}/{}", relative.to_string_lossy().replace('\\', "/")),
                file,
            ));
        }
    }
    inputs
}

fn collect_files(root: &Path, filter: &dyn Fn(&Path) -> bool, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("__tests__" | "__mocks__" | "__fixtures__")
            ) {
                collect_files(&path, filter, files);
            }
        } else if filter(&path) {
            files.push(path);
        }
    }
}

/// A digest of the files' names and contents. A missing file hashes as empty.
fn files_digest(files: &[(String, PathBuf)]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    STAMP_VERSION.hash(&mut hasher);
    for (name, file) in files {
        name.hash(&mut hasher);
        fs::read(file).unwrap_or_default().hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn watch_cpp_tree(root: &Path, skip_dirs: &[&str]) {
    if !root.is_dir() {
        return;
    }
    for entry in fs::read_dir(root).expect("read C++ source directory") {
        let path = entry.expect("read C++ source entry").path();
        if path.is_dir() {
            let name = path.file_name().and_then(|name| name.to_str());
            if matches!(name, Some("build" | "target"))
                || name.is_some_and(|name| skip_dirs.contains(&name))
            {
                continue;
            }
            watch_cpp_tree(&path, skip_dirs);
            continue;
        }

        let is_source = matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("c" | "cc" | "cpp" | "cxx" | "m" | "mm" | "h" | "hh" | "hpp" | "hxx" | "cmake")
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
fn configure_stamp(
    defines: &[(&str, String)],
    profile: &str,
    target: &str,
    autolink_codegen: &str,
    generator: &str,
    compiler_flags: &[String],
) -> String {
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
    stamp.push_str("autolink_codegen=");
    stamp.push_str(autolink_codegen);
    stamp.push('\n');
    stamp.push_str("cmake_version=");
    stamp.push_str(&cmake_version());
    stamp.push('\n');
    stamp.push_str("generator=");
    stamp.push_str(generator);
    stamp.push('\n');
    stamp.push_str("compiler_flags=");
    stamp.push_str(&compiler_flags.join(" "));
    stamp.push('\n');
    stamp
}

/// The generator to hand CMake: Ninja when it is on `PATH`, unless the user
/// chose one through `CMAKE_GENERATOR` (in any form the `cmake` crate reads).
/// MSVC keeps the Visual Studio generator: Ninja there needs a developer
/// prompt's environment for every `cmake --build`, and the unity build and
/// `/MP` in `cpp/CMakeLists.txt` are tuned for MSBuild.
fn cmake_generator(use_ccache: bool) -> Option<&'static str> {
    let target = env::var("TARGET").unwrap_or_default();
    let user_chose = configure_env_names(&target)
        .iter()
        .filter(|name| name.ends_with("CMAKE_GENERATOR") || name.starts_with("CMAKE_GENERATOR_"))
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()));
    if user_chose {
        return None;
    }
    // MSVC keeps the Visual Studio generator, which ignores the compiler
    // launcher, unless ccache can actually be used: then Ninja, which needs the
    // compiler environment (vcvars) of the shell, so `cl.exe` must be on PATH.
    if msvc_target() && !(use_ccache && program_on_path("cl")) {
        return None;
    }
    program_on_path("ninja").then_some("Ninja")
}

/// Keeps a build directory whose source or build path moved (another checkout,
/// or a target dir copied from one) instead of letting the `cmake` crate wipe
/// it: its `maybe_clear` deletes the whole directory when the cache names
/// another source dir, and CMake refuses a cache made in another build dir.
/// Only the cache goes, so the configure that follows starts clean while the
/// objects and downloaded dependencies stay for the build to reuse. A changed
/// generator also drops `CMakeFiles`, whose layout is generator-specific.
fn reuse_build_dir(build_dir: &Path, source_dir: &Path, generator: Option<&str>) {
    let cache = build_dir.join("CMakeCache.txt");
    let Ok(contents) = fs::read_to_string(&cache) else {
        return;
    };
    let entry = |name: &str| {
        contents.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.split(':').next() == Some(name)).then(|| value.to_string())
        })
    };
    let same_dir = |cached: Option<String>, current: &Path| {
        let current = current
            .canonicalize()
            .unwrap_or_else(|_| current.to_path_buf());
        cached
            .and_then(|cached| Path::new(&cached).canonicalize().ok())
            .is_some_and(|cached| cached == current)
    };
    let generator_changed =
        generator.is_some_and(|generator| entry("CMAKE_GENERATOR").as_deref() != Some(generator));
    let moved = !same_dir(entry("CMAKE_HOME_DIRECTORY"), source_dir)
        || !same_dir(entry("CMAKE_CACHEFILE_DIR"), build_dir);
    if !moved && !generator_changed {
        return;
    }
    println!(
        "rn-gpui-sys: {} changed; reconfiguring {} in place",
        if generator_changed {
            "CMake generator"
        } else {
            "source or build path"
        },
        build_dir.display()
    );
    fs::remove_file(&cache).expect("remove stale CMakeCache.txt");
    if generator_changed {
        let _ = fs::remove_dir_all(build_dir.join("CMakeFiles"));
    }
}

/// The deepest directory that holds every one of `paths` (as given, and with
/// symlinks resolved), or `None` when that is the filesystem root.
fn common_ancestor(paths: &[&Path]) -> Option<PathBuf> {
    common_ancestor_of(paths.iter().map(|path| path.to_path_buf()).collect())
}

fn canonical_common_ancestor(paths: &[&Path]) -> Option<PathBuf> {
    common_ancestor_of(
        paths
            .iter()
            .map(|path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
            .collect(),
    )
}

fn common_ancestor_of(paths: Vec<PathBuf>) -> Option<PathBuf> {
    let first = paths.first()?;
    let ancestor = first
        .ancestors()
        .find(|ancestor| paths.iter().all(|path| path.starts_with(ancestor)))?;
    (ancestor.parent().is_some()).then(|| ancestor.to_path_buf())
}

/// `-ffile-prefix-map` flags (GCC 8+, Clang 10+) for the checkout (the
/// directory holding the package and the app's `node_modules`, spelled as the
/// build names it and with symlinks resolved) and the CMake output dir, mapped
/// to fixed names so objects and their debug info do not depend on where the
/// checkout lives. The build dir comes last because it can sit inside the
/// checkout, and the last matching map wins. They travel in CMake's
/// space-separated flag strings, so a path with whitespace is left unmapped.
/// The flags are not in `cpp/`, whose contents key the prebuilt runtime.
fn prefix_map_flags_for(source_root: Option<&Path>, cmake_out_dir: &Path) -> Vec<String> {
    let mut maps: Vec<String> = Vec::new();
    let mut add = |path: &Path, name: &str| {
        let path = cmake_path(path);
        if path.contains(char::is_whitespace) {
            return;
        }
        let map = format!("-ffile-prefix-map={path}={name}");
        if !maps.contains(&map) {
            maps.push(map);
        }
    };
    if let Some(root) = source_root {
        add(root, "/rn-gpui/src");
        if let Ok(canonical) = root.canonicalize() {
            add(&canonical, "/rn-gpui/src");
        }
    }
    add(cmake_out_dir, "/rn-gpui/build");
    if let Ok(canonical) = cmake_out_dir.canonicalize() {
        add(&canonical, "/rn-gpui/build");
    }
    maps
}

/// Points ccache at the paths the build uses, unless the user configured it:
/// `base_dir` makes it hash the checkout's paths relative to the build dir, and
/// `hash_dir` off stops it hashing the working directory, which the prefix maps
/// already keep out of the objects.
fn configure_ccache_env(source_root: Option<&Path>, cmake_out_dir: &Path) {
    let ccache_config = |key: &str| {
        Command::new("ccache")
            .args(["-k", key])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let mut vars = Vec::new();
    // MSVC is left without `base_dir`: the relative include paths it makes ccache
    // write exceed `MAX_PATH` from the build dir.
    if !msvc_target()
        && env::var_os("CCACHE_BASEDIR").is_none()
        && ccache_config("base_dir").is_empty()
    {
        if let Some(base) =
            source_root.and_then(|root| canonical_common_ancestor(&[root, cmake_out_dir]))
        {
            vars.push(("CCACHE_BASEDIR", base.into_os_string()));
        }
    }
    if !msvc_target()
        && env::var_os("CCACHE_NOHASHDIR").is_none()
        && env::var_os("CCACHE_HASHDIR").is_none()
    {
        vars.push(("CCACHE_NOHASHDIR", "1".into()));
    }
    for (name, value) in vars {
        // The build script is single-threaded here; every CMake and compiler
        // process it starts from now on inherits these.
        env::set_var(name, value);
    }
}

/// A digest of the headers React Native's codegen made for the app's specs. The
/// configure step runs the codegen again for the libraries that read it, so a
/// changed spec has to configure again, and an unchanged one must not.
fn autolink_codegen_digest(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut files = Vec::new();
    collect_headers(root, &mut files);
    files.sort();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for file in files {
        file.hash(&mut hasher);
        fs::read(&file).unwrap_or_default().hash(&mut hasher);
        println!("cargo:rerun-if-changed={}", file.display());
    }
    format!("{:016x}", hasher.finish())
}

fn collect_headers(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_headers(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "h") {
            files.push(path);
        }
    }
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
fn select_prebuilt_dir(
    package_dir: &Path,
    target: &str,
    mode: &str,
    renderer: &str,
) -> Option<PathBuf> {
    let dir = select_prebuilt_dir_inner(package_dir, target, mode, renderer)?;
    match prebuilt_version(&dir) {
        Some(version) => println!(
            "cargo:warning=rn-gpui-sys: using prebuilt {renderer} runtime {version} ({target})"
        ),
        None => println!(
            "cargo:warning=rn-gpui-sys: using prebuilt {renderer} runtime {} ({target})",
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

fn select_prebuilt_dir_inner(
    package_dir: &Path,
    target: &str,
    mode: &str,
    renderer: &str,
) -> Option<PathBuf> {
    if env_flag("RN_GPUI_BUILD_FROM_SOURCE") || mode == "never" {
        return None;
    }
    let require = mode == "always";
    if let Some(dir) = env::var_os("RN_GPUI_PREBUILT_DIR") {
        let dir = PathBuf::from(dir);
        return match check_prebuilt_react_native(&dir, package_dir, renderer) {
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
    if let Err(reason) = check_pinned_inputs(package_dir, renderer) {
        fallback_or_panic(require, &reason);
        return None;
    }

    let script = package_dir.join("scripts").join("prebuilt-binaries.mjs");
    let output = Command::new("node")
        .arg(&script)
        .arg("ensure")
        .arg("--triple")
        .arg(target)
        .arg("--renderer")
        .arg(renderer)
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if dir.is_empty() {
                fallback_or_panic(require, "prebuilt-binaries.mjs printed no directory");
                return None;
            }
            let dir = PathBuf::from(dir);
            match check_prebuilt_react_native(&dir, package_dir, renderer) {
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
fn check_prebuilt_react_native(
    dir: &Path,
    package_dir: &Path,
    renderer: &str,
) -> Result<(), String> {
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
    if renderer == "loom" {
        let built_with = manifest.get("loom").and_then(|value| value.as_str());
        let pinned = fs::read_to_string(package_dir.join("ReactGpui").join("loom-pin.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|pin| pin.get("commit")?.as_str().map(str::to_owned));
        if built_with.is_none() || built_with != pinned.as_deref() {
            return Err(format!(
                "prebuilt runtime was built with Loom {}, this package pins Loom {}",
                built_with.unwrap_or("none"),
                pinned.as_deref().unwrap_or("none")
            ));
        }
    }
    Ok(())
}

/// A repository checkout may have C++ edits the pinned archive does not
/// contain, so its inputs must hash to the pin's `inputHash`.
fn check_pinned_inputs(package_dir: &Path, renderer: &str) -> Result<(), String> {
    let pin_path = package_dir.join("prebuilt-binaries.json");
    println!("cargo:rerun-if-changed={}", pin_path.display());
    let pinned = fs::read_to_string(&pin_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|pin| {
            let section = if renderer == "loom" {
                pin.get("loom")?
            } else {
                &pin
            };
            section.get("inputHash")?.as_str().map(str::to_owned)
        })
        .ok_or_else(|| format!("{} has no {renderer} inputHash", pin_path.display()))?;
    let output = Command::new("node")
        .arg(package_dir.join("scripts").join("prebuilt-inputs.mjs"))
        .arg("--renderer")
        .arg(renderer)
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

/// The folder the C++ build keeps the downloaded, extracted and built native
/// dependencies (Boost, folly, OpenSSL, curl...) in. It is shared by every build
/// of every checkout, so a new target folder or worktree does not fetch and
/// compile them again. Order: `RN_GPUI_NATIVE_DEPS_CACHE`; `native-deps` in
/// `RN_GPUI_PREBUILT_CACHE` when that is set; `native-deps` in the per-user
/// `react-native-gpui` cache folder the prebuilt runtime uses
/// (`scripts/prebuilt-binaries.mjs`); and, where the machine has no user cache
/// folder, a folder in the Cargo target dir.
fn native_deps_cache_dir(cargo_target_dir: &Path) -> PathBuf {
    let set = |name: &str| env::var_os(name).filter(|value| !value.is_empty());
    let absolute = |path: PathBuf| {
        if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .expect("read build-script working directory")
                .join(path)
        }
    };
    if let Some(dir) = set("RN_GPUI_NATIVE_DEPS_CACHE") {
        return absolute(PathBuf::from(dir));
    }
    if let Some(dir) = set("RN_GPUI_PREBUILT_CACHE") {
        return absolute(PathBuf::from(dir)).join("native-deps");
    }
    let home = env::home_dir().filter(|dir| !dir.as_os_str().is_empty());
    // The build script runs on the host, so these are the host's cache folders.
    let user_cache = if cfg!(target_os = "macos") {
        home.map(|home| home.join("Library").join("Caches"))
    } else if cfg!(windows) {
        set("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join("AppData").join("Local")))
    } else {
        set("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| home.map(|home| home.join(".cache")))
    };
    match user_cache {
        Some(dir) => dir.join("react-native-gpui").join("native-deps"),
        None => cargo_target_dir.join("rn-gpui-native-deps"),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(env::var(name).as_deref(), Ok("1") | Ok("true"))
}

fn overrides_sha256(package_dir: &Path, renderer: &str) -> String {
    let output = Command::new("node")
        .arg(package_dir.join("scripts").join("prebuilt-inputs.mjs"))
        .arg("--overrides-sha256")
        .arg("--renderer")
        .arg(renderer)
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
/// `packages/hermes`), while an app has every one of them in `node_modules`.
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

/// Watches a file autolink writes. Cargo reruns a build script on every build
/// while a watched path is missing, so a missing file is watched through its
/// directory, and not at all without one (a build without autolink): the CLI
/// names the files through `RN_GPUI_AUTOLINK_*`, which are watched themselves.
fn watch_generated_file(path: &Path) {
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    } else if let Some(dir) = path.parent().filter(|dir| dir.is_dir()) {
        println!("cargo:rerun-if-changed={}", dir.display());
    }
}

/// Has `cc` compile the cxx bridge through ccache: `cc` takes `ccache <compiler>`
/// in `CXX_<target>` as a wrapper, and has no other way to be given one. Returns
/// the variable to clear afterwards, or `None` when the user named a C++
/// compiler, which is left alone.
fn launch_bridge_through_ccache(compiler: &Path, target: &str) -> Option<String> {
    let target_underscored = target.replace(['-', '.'], "_");
    let user_set = [
        format!("CXX_{target}"),
        format!("CXX_{target_underscored}"),
        "HOST_CXX".to_string(),
        "TARGET_CXX".to_string(),
        "CXX".to_string(),
    ]
    .iter()
    .any(|name| env::var_os(name).is_some());
    let compiler = compiler.to_str()?;
    if user_set || compiler.contains(char::is_whitespace) {
        return None;
    }
    let variable = format!("CXX_{target}");
    // The build script is single-threaded here.
    env::set_var(&variable, format!("ccache {compiler}"));
    Some(variable)
}

/// Whether a `ccache` binary is on `PATH`.
///
/// Only used to decide whether to hand CMake the compiler launcher: setting it
/// to a binary that is not there fails the configure, and a machine without
/// ccache has to build without it.
fn ccache_available() -> bool {
    program_on_path("ccache")
}

fn program_on_path(name: &str) -> bool {
    let path = match env::var_os("PATH") {
        Some(path) => path,
        None => return false,
    };
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    env::split_paths(&path).any(|dir| dir.join(&exe).is_file())
}

/// The directory a target's CMake tree is named after. cl.exe cannot write an
/// object file whose absolute path reaches MAX_PATH (260), and the longest
/// ReactCommon objects sit about 170 characters below the tree, so the Windows
/// directories are short.
fn cmake_triple_dir(triple: &str) -> &str {
    match triple {
        "x86_64-pc-windows-msvc" => "x64",
        "aarch64-pc-windows-msvc" => "arm64",
        other => other,
    }
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
