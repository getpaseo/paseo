#include "GpuiHttpBridge.h"

#include <react/http/IHttpClient.h>

// The completion callback's declaration, exactly as cxx emits it.
//
// Hand-writing it is what broke the Windows build: this file has to declare
// `rngpui::rn_gpui_http_complete` so the call below links, and a hand-written
// version without `noexcept` is a different function when MSVC sees both in one
// unity translation unit — C2382. macOS and Linux compile this file alone and
// never met the generated declaration, so only Windows refused.
#include "rn-gpui-sys/src/lib.rs.h" // rn_gpui_http_complete

#include <atomic>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "GpuiHttpClient.h"

namespace rngpui {

namespace {

/// The HTTP interface lives under `facebook::react`, like the rest of the C++
/// runtime; the alias keeps the body readable.
namespace http = facebook::react::http;
using facebook::react::IHttpClient;

/// One response, assembled from the client's callbacks.
struct Result {
  int status{0};
  http::Headers headers;
  std::string body;
  std::string error;
  bool done{false};
};

/// The handle a cancelled request is found by.
struct InFlight {
  std::atomic<bool> cancelled{false};
};

std::mutex g_requestsMutex;
std::map<std::uint64_t, std::shared_ptr<InFlight>> g_requests;

/// "name: value" lines, newline separated. One string rather than a cxx struct:
/// header maps are small and this crosses the boundary rarely.
http::Headers parseHeaders(const std::string& text) {
  http::Headers headers;
  std::size_t start = 0;
  while (start <= text.size() && !text.empty()) {
    const auto end = text.find('\n', start);
    const auto line = text.substr(
        start, end == std::string::npos ? std::string::npos : end - start);
    const auto colon = line.find(':');
    if (colon != std::string::npos) {
      std::string value = line.substr(colon + 1);
      while (!value.empty() &&
             (value.front() == ' ' || value.front() == '\t')) {
        value.erase(value.begin());
      }
      while (!value.empty() && (value.back() == '\r' || value.back() == ' ')) {
        value.pop_back();
      }
      // `Headers` is a vector of pairs, not a map: React Native preserves the
      // order the server sent, and a map would sort them.
      headers.emplace_back(line.substr(0, colon), std::move(value));
    }
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return headers;
}

std::string serializeHeaders(const http::Headers& headers) {
  std::string text;
  for (const auto& [name, value] : headers) {
    if (!text.empty()) {
      text.push_back('\n');
    }
    text += name;
    text += ": ";
    text += value;
  }
  return text;
}

} // namespace

void rn_gpui_http_request(
    std::uint64_t request_id,
    ::rust::Str method,
    ::rust::Str url,
    ::rust::Str headers,
    ::rust::Str body) {
  auto state = std::make_shared<InFlight>();
  {
    std::lock_guard<std::mutex> lock(g_requestsMutex);
    g_requests[request_id] = state;
  }

  const std::string methodText(method.data(), method.size());
  const std::string urlText(url.data(), url.size());
  const std::string headersText(headers.data(), headers.size());
  const std::string bodyText(body.data(), body.size());

  std::thread(
      [request_id, state, methodText, urlText, headersText, bodyText]() {
        auto result = std::make_shared<Result>();
        auto finished = std::make_shared<std::mutex>();
        auto condition = std::make_shared<std::condition_variable>();

        http::NetworkCallbacks callbacks;
        callbacks.onResponse = [result](
                                   uint16_t code,
                                   http::Headers responseHeaders,
                                   std::string /*responseUrl*/) {
          result->status = code;
          result->headers = std::move(responseHeaders);
        };
        callbacks.onBody = [result](std::unique_ptr<folly::IOBuf> data) {
          if (!data) {
            return;
          }
          for (const auto& range : *data) {
            result->body.append(
                reinterpret_cast<const char*>(range.data()), range.size());
          }
        };
        callbacks.onResponseComplete = [result, finished, condition](
                                           std::string error,
                                           bool /*timeoutError*/) {
          result->error = std::move(error);
          {
            std::lock_guard<std::mutex> lock(*finished);
            result->done = true;
          }
          condition->notify_all();
        };

        // One client per request: `CurlHttpClient` is stateless, and the
        // cookies it shares live in a process-wide handle created on first use.
        auto client = gpui_http_client_factory()();
        client->sendRequest(
            std::move(callbacks),
            methodText,
            urlText,
            parseHeaders(headersText),
            http::Body{.string = bodyText});

        // `sendRequest` returns as soon as the transfer has been started on its
        // own thread, so the response is awaited here rather than assumed.
        {
          std::unique_lock<std::mutex> lock(*finished);
          condition->wait(lock, [&result] { return result->done; });
        }
        {
          std::lock_guard<std::mutex> lock(g_requestsMutex);
          g_requests.erase(request_id);
        }
        if (state->cancelled.load(std::memory_order_relaxed)) {
          return;
        }
        const auto serialized = serializeHeaders(result->headers);
        // `rust::Slice` for the body: it is raw response bytes, and an image
        // response is not UTF-8.
        rn_gpui_http_complete(
            request_id,
            result->status,
            ::rust::Str(serialized.data(), serialized.size()),
            ::rust::Slice<const std::uint8_t>(
                reinterpret_cast<const std::uint8_t*>(result->body.data()),
                result->body.size()),
            ::rust::Str(result->error.data(), result->error.size()));
      })
      .detach();
}

void rn_gpui_http_request_cancel(std::uint64_t request_id) {
  std::lock_guard<std::mutex> lock(g_requestsMutex);
  const auto it = g_requests.find(request_id);
  if (it != g_requests.end()) {
    it->second->cancelled.store(true, std::memory_order_relaxed);
  }
}

} // namespace rngpui
