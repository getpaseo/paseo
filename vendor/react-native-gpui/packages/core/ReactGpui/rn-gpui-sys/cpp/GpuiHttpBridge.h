#pragma once

#include <cstdint>
#include "rust/cxx.h"

namespace rngpui {

// One request, issued for GPUI's image, font and remote vector image loading.
//
// GPUI's `HttpClient` is synchronous from the caller's point of view: it
// returns a future that resolves when the response is complete. React Native's
// client is callback-shaped, so this runs the request on its own thread and
// reports the whole response at the end. `request_id` is echoed back on the
// Rust side.
//
// The request counts in `rn_gpui_http_requests_in_flight` for its lifetime, so
// the test driver's idle detection covers image and font loads too.
void rn_gpui_http_request(
    std::uint64_t request_id,
    rust::Str method,
    rust::Str url,
    rust::Str headers,
    rust::Str body);

// Cancels an in-flight request, if it is still running.
void rn_gpui_http_request_cancel(std::uint64_t request_id);

} // namespace rngpui
