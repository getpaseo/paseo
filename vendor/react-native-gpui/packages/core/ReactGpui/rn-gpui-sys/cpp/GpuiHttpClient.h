// ReactHost's constructor throws unless an HttpClientFactory is in the
// ContextContainer.
#pragma once

#include <react/http/IHttpClient.h>
#include <cstdint>

namespace rngpui {
facebook::react::HttpClientFactory gpui_http_client_factory();
bool gpui_http_client_clear_cookies();
extern "C" uint64_t rn_gpui_http_requests_in_flight() noexcept;
extern "C" uint64_t rn_gpui_http_requests_not_ignored(
    const char* newline_separated_patterns) noexcept;

} // namespace rngpui
