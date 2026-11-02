// Standard headers that MSVC's standard library does not pull in
// transitively the way libc++ does.
//
// ReactCommon (and folly) rely on the libc++ behaviour in places, for example
// jsinspector-modern/HostTarget.h uses std::mutex without including <mutex>.
// This header is force-included into every C++ translation unit on MSVC
// (`/FI`), mirroring the `-include cstdint` the Linux build already needs.
#pragma once

/* M_PI and friends are only exposed when this is defined before <cmath>. */
#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

/* ReactCommon calls __builtin_trap() in a few places. */
#if !defined(__builtin_trap)
#define __builtin_trap() __debugbreak()
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

// Additional headers MSVC does not reach transitively from ReactCommon's own
// includes (react-native-windows force-includes the same set through its PCH).
#include <array>
#include <cstring>
#include <exception>
#include <limits>
#include <memory_resource>
#include <string_view>
#include <tuple>
#include <type_traits>

#include <bit>
#include <charconv>
#include <compare>
#include <concepts>
#include <span>
#include <version>
