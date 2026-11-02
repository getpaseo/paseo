#pragma once

#include <cstdint>
#include "rust/cxx.h"

namespace rngpui {

/// Emit an `os_signpost` point event for a startup stage.
///
/// This lives in C++ because `os/signpost.h` declares its API as macros over a
/// variadic implementation function, and getting that ABI right by hand in Rust
/// is exactly the kind of thing that crashes on the first call. Here the macro
/// expands as Apple intends and there is nothing to transcribe.
///
/// A no-op on platforms without signposts.
void rn_gpui_startup_signpost(::rust::Str stage, std::uint64_t elapsed_ms);

} // namespace rngpui
