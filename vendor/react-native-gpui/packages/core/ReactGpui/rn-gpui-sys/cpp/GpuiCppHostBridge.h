#pragma once

#include <cstddef>
#include <cstdint>

namespace rngpui {

/// Creates the C++ view of the node of component `index` and gives it its
/// first props (`props` is a props handle's address). Returns 0 when no C++
/// implementation is registered for the index.
uint64_t
rn_gpui_cpp_host_create(uint32_t index, int32_t tag, std::size_t props);

void rn_gpui_cpp_host_update(uint64_t id, std::size_t props);

/// Creates the node's native view. The result's kind is 0 for a composited
/// view, 1 for an NSView (the returned value) and 2 for an X11 window.
uint64_t rn_gpui_cpp_host_create_view(
    uint64_t id,
    std::size_t windows_visual,
    bool wayland,
    uint32_t x11_window,
    std::size_t xcb_connection,
    std::size_t wayland_display,
    std::size_t wayland_surface,
    uint8_t& kind);

void rn_gpui_cpp_host_destroy(uint64_t id);

} // namespace rngpui
