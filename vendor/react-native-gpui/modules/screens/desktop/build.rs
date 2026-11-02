//! Puts the C++ runtime's shared libraries on this crate's test binary rpath.
//!
//! `rn-gpui-screens`'s tests build gpui trees, which link `libjsi.dylib` and the
//! rest of the Node-API runtime. Core's `build.rs` emits
//! `cargo:rustc-link-arg=-Wl,-rpath,<dir>` for its own binary — the app — and that
//! flag is not inherited by a dependency's test binary, so the test process
//! aborted in dyld with `Library not loaded: @rpath/libjsi.dylib` before running a
//! single test.
//!
//! Core exports the directories it was given as `DEP_RN_GPUI_CORE_RPATHS`, which
//! is the same variable core's own `build.rs` reads. Re-emitting it here scopes
//! the flag to this crate's test binary, since `cargo:rustc-link-arg` without a
//! target suffix applies to the crate's own targets and not to the app that
//! depends on it.

fn main() {
    println!("cargo:rerun-if-env-changed=DEP_RN_GPUI_CORE_RPATHS");
    println!("cargo:rerun-if-changed=build.rs");

    let Ok(dirs) = std::env::var("DEP_RN_GPUI_CORE_RPATHS") else {
        return;
    };
    let dirs = dirs
        .split('|')
        .filter(|dir| !dir.is_empty())
        .collect::<Vec<_>>();
    if dirs.is_empty() {
        return;
    }
    // MSVC and MinGW have no rpath, and the flag is rejected outright; Windows
    // finds the DLLs through PATH, which the test runner already arranges.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        return;
    }
    for dir in dirs {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
