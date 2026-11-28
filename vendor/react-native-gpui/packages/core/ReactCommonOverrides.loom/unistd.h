#pragma once

// Loom's LoomBindingInternals.h includes <unistd.h> and calls nothing from it.
// MSVC has no such header; every other toolchain gets the real one.
#if defined(_MSC_VER)
#include <io.h>
#include <process.h>
#else
#include_next <unistd.h>
#endif
