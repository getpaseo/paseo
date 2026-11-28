// The proxy and DNS settings applied to one curl request. Kept apart from
// GpuiNetworkConfig.h, which the Rust bridge compiles without curl's headers.
#pragma once

#include <curl/curl.h>
#include <cstddef>
#include <string>

namespace rngpui {

// Sets the proxy and resolver options of one request.
void applyNetworkConfig(CURL* handle, const std::string& url);

// After a request failed to resolve its host: moves it to the next
// DNS-over-HTTPS server, and after the last one to the system resolver.
// `attempt` counts the servers tried and starts at 0. Returns false when there
// is nothing left to try, or no server is set.
bool fallBackResolver(CURL* handle, size_t& attempt);

} // namespace rngpui
