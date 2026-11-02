#pragma once

// Force-included on Linux (see CMakeLists.txt), before every C++ translation
// unit in this tree. React Native's headers and the packages it bundles rely on
// the libc++ headers shipping transitively; GCC/libstdc++ does not.
//
//   - RN 0.87.1 uses `uint*_t` without including <cstdint> in several headers.
//     `CSS/common/transforms/vectors.h` uses bare `size_t` and only gets it
//     from <iostream>, which it includes *only when NDEBUG is undefined*. A
//     Release build defines NDEBUG, so that header lost `size_t` and the build
//     failed with "'size_t' has not been declared" in a third-party file.
//
// Both are declared here instead of patching the packages. It is one header so
// the compiler is given a single `-include` argument: CMake de-duplicates
// repeated options, and a second `-include <header>` pair collapses.
#include <cstddef>
#include <cstdint>
