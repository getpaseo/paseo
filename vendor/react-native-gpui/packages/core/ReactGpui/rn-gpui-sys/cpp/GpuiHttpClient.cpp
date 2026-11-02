#include "GpuiHttpClient.h"
#include <react/io/BlobModule.h>

#include <curl/curl.h>

#include <folly/Uri.h>
#include <folly/io/IOBuf.h>
#include <glog/logging.h>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace rngpui {
namespace {
using namespace facebook::react;

// curl_global_init() is not thread-safe and has to run before any other libcurl
// call, so every client construction goes through call_once().
void ensureCurlInitialized() {
  static std::once_flag once;
  std::call_once(once, []() { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

struct SharedCookies {
  CURLSH* handle{curl_share_init()};
  std::mutex mutex;

  SharedCookies() {
    curl_share_setopt(handle, CURLSHOPT_LOCKFUNC, lock);
    curl_share_setopt(handle, CURLSHOPT_UNLOCKFUNC, unlock);
    curl_share_setopt(handle, CURLSHOPT_USERDATA, this);
    curl_share_setopt(handle, CURLSHOPT_SHARE, CURL_LOCK_DATA_COOKIE);
  }
  ~SharedCookies() {
    curl_share_cleanup(handle);
  }

  static void lock(CURL*, curl_lock_data, curl_lock_access, void* data) {
    static_cast<SharedCookies*>(data)->mutex.lock();
  }
  static void unlock(CURL*, curl_lock_data, void* data) {
    static_cast<SharedCookies*>(data)->mutex.unlock();
  }
};

SharedCookies& sharedCookies() {
  static SharedCookies cookies;
  return cookies;
}

// Shared by the worker thread and the token handed back to the caller: cancel()
// can be called from any thread at any time.
struct Cancellation {
  std::atomic<bool> cancelled{false};
};

std::atomic<uint64_t> httpRequestsInFlight{0};
std::mutex httpRequestsMutex;
std::unordered_map<std::string, uint64_t> httpRequestUrlsInFlight;

struct RequestActivity {
  explicit RequestActivity(const std::string& url) : url_(url) {
    httpRequestsInFlight.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(httpRequestsMutex);
    ++httpRequestUrlsInFlight[url_];
  }
  ~RequestActivity() {
    httpRequestsInFlight.fetch_sub(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(httpRequestsMutex);
    auto it = httpRequestUrlsInFlight.find(url_);
    if (it != httpRequestUrlsInFlight.end() && --it->second == 0) {
      httpRequestUrlsInFlight.erase(it);
    }
  }

 private:
  std::string url_;
};

class CurlRequestToken final : public http::IRequestToken {
 public:
  explicit CurlRequestToken(std::shared_ptr<Cancellation> cancellation)
      : cancellation_(std::move(cancellation)) {}

  void cancel() noexcept override {
    cancellation_->cancelled.store(true, std::memory_order_relaxed);
  }

 private:
  std::shared_ptr<Cancellation> cancellation_;
};

struct Transfer {
  std::shared_ptr<Cancellation> cancellation;
  http::NetworkCallbacks callbacks;
  std::string body;
  http::Headers responseHeaders;
  int64_t receivedBytes{0};
  int64_t totalBytes{-1};
  int64_t uploadedBytes{0};
  int64_t totalUploadBytes{-1};
};

bool isCancelled(const Transfer& transfer) {
  return transfer.cancellation->cancelled.load(std::memory_order_relaxed);
}

// Returning a short count makes libcurl abort the transfer with
// CURLE_WRITE_ERROR, which is how cancellation interrupts a download in
// progress.
size_t writeCallback(char* data, size_t size, size_t count, void* userData) {
  auto& transfer = *static_cast<Transfer*>(userData);
  if (isCancelled(transfer)) {
    return 0;
  }

  const auto length = static_cast<int64_t>(size * count);

  // `sendIncrementalUpdates` asks for the body as it arrives instead of one
  // buffer at the end; the two delivery styles are mutually exclusive.
  if (transfer.callbacks.sendIncrementalUpdates &&
      transfer.callbacks.onBodyIncremental) {
    const int64_t consumed = transfer.callbacks.onBodyIncremental(
        transfer.receivedBytes,
        transfer.totalBytes,
        folly::IOBuf::copyBuffer(data, static_cast<size_t>(length)));
    if (consumed < length) {
      return 0;
    }
  } else {
    transfer.body.append(data, static_cast<size_t>(length));
  }

  transfer.receivedBytes += length;
  if (transfer.callbacks.sendProgressUpdates &&
      transfer.callbacks.onBodyProgress) {
    transfer.callbacks.onBodyProgress(
        transfer.receivedBytes, transfer.totalBytes);
  }
  return size * count;
}

// libcurl hands the header block over one line at a time, status line first and
// a blank line last.
size_t headerCallback(char* data, size_t size, size_t count, void* userData) {
  auto& transfer = *static_cast<Transfer*>(userData);
  const size_t length = size * count;
  const std::string_view line(data, length);

  if (isCancelled(transfer)) {
    return 0;
  }
  if (line.starts_with("HTTP/")) {
    // libcurl reports each redirect/interim response header block. Only the
    // final response headers belong on the Fetch Response.
    transfer.responseHeaders.clear();
  }
  if (line == "\r\n" || line == "\n") {
    return length; // End of the response header block.
  }

  const size_t colon = line.find(':');
  if (colon != std::string_view::npos) {
    std::string_view name = line.substr(0, colon);
    std::string_view value = line.substr(colon + 1);
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
      value.remove_prefix(1);
    }
    while (
        !value.empty() &&
        (value.back() == '\r' || value.back() == '\n' || value.back() == ' ')) {
      value.remove_suffix(1);
    }
    transfer.responseHeaders.emplace_back(
        std::string(name), std::string(value));
  }
  return length;
}

// The callback that keeps cancellation responsive between writes and, as a
// side effect, tells us the expected body size for progress reporting.
int progressCallback(
    void* userData,
    curl_off_t dltotal,
    curl_off_t /*dlnow*/,
    curl_off_t ultotal,
    curl_off_t ulnow) {
  auto& transfer = *static_cast<Transfer*>(userData);
  if (dltotal > 0) {
    transfer.totalBytes = static_cast<int64_t>(dltotal);
  }
  if (ultotal >= 0) {
    transfer.totalUploadBytes = static_cast<int64_t>(ultotal);
  }
  if (ulnow >= 0 && static_cast<int64_t>(ulnow) != transfer.uploadedBytes) {
    transfer.uploadedBytes = static_cast<int64_t>(ulnow);
    if (transfer.callbacks.onUploadProgress) {
      transfer.callbacks.onUploadProgress(
          transfer.uploadedBytes, transfer.totalUploadBytes);
    }
  }
  return isCancelled(transfer) ? 1 : 0; // Non-zero aborts the transfer.
}

struct CurlHandle {
  CURL* handle{nullptr};
  curl_slist* headers{nullptr};
  curl_mime* mime{nullptr};

  ~CurlHandle() {
    if (mime != nullptr) {
      curl_mime_free(mime);
    }
    curl_slist_free_all(headers);
    if (handle != nullptr) {
      curl_easy_cleanup(handle);
    }
  }
};

std::optional<std::string> decodeBase64(std::string_view input) {
  static constexpr std::string_view alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  uint32_t value = 0;
  int bits = -8;
  for (char ch : input) {
    if (ch == '=') {
      break;
    }
    if (ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t') {
      continue;
    }
    const auto index = alphabet.find(ch);
    if (index == std::string_view::npos) {
      return std::nullopt;
    }
    value = (value << 6) | static_cast<uint32_t>(index);
    bits += 6;
    if (bits >= 0) {
      result.push_back(static_cast<char>((value >> bits) & 0xff));
      bits -= 8;
    }
  }
  return result;
}

bool addFormData(curl_mime* mime, const http::FormData& fields) {
  for (const auto& field : fields) {
    auto* part = curl_mime_addpart(mime);
    curl_mime_name(part, field.fieldName.c_str());
    std::string filename;
    for (const auto& [name, value] : field.headers) {
      if (name == "Content-Type" || name == "content-type") {
        curl_mime_type(part, value.c_str());
      } else if (
          name == "Content-Disposition" || name == "content-disposition") {
        const auto filenamePos = value.find("filename=\"");
        if (filenamePos != std::string::npos) {
          const auto start = filenamePos + 10;
          const auto end = value.find('"', start);
          if (end != std::string::npos) {
            filename = value.substr(start, end - start);
          }
        }
      }
    }
    if (field.string) {
      curl_mime_data(part, field.string->data(), field.string->size());
    } else if (field.uri) {
      std::string path = *field.uri;
      if (path.starts_with("file://")) {
        path.erase(0, 7);
      }
      if (curl_mime_filedata(part, path.c_str()) != CURLE_OK) {
        return false;
      }
      if (!filename.empty()) {
        curl_mime_filename(part, filename.c_str());
      }
    }
  }
  return true;
}

void performRequest(
    Transfer transfer,
    const std::string& method,
    const std::string& url,
    const http::Headers& requestHeaders,
    const http::Body& requestBody,
    uint32_t timeout) {
  const RequestActivity activity(url);
  const auto complete = [&transfer](std::string error, bool timeoutError) {
    if (transfer.callbacks.onResponseComplete) {
      transfer.callbacks.onResponseComplete(std::move(error), timeoutError);
    }
  };

  if (url.starts_with("blob:")) {
    try {
      const folly::Uri uri(url);
      auto path = uri.path();
      while (!path.empty() && path.front() == '/') {
        path.erase(path.begin());
      }
      uint64_t offset = 0;
      uint64_t size = std::numeric_limits<uint64_t>::max();
      const auto query = uri.query();
      const auto offsetKey = query.find("offset=");
      if (offsetKey != std::string::npos) {
        offset = std::stoull(query.substr(offsetKey + 7));
      }
      const auto sizeKey = query.find("size=");
      if (sizeKey != std::string::npos) {
        size = std::stoull(query.substr(sizeKey + 5));
      }
      auto data = readBlob(path, offset, size);
      if (!data) {
        if (transfer.callbacks.onResponse) {
          transfer.callbacks.onResponse(404, {}, url);
        }
        complete("Blob URL is no longer available", false);
        return;
      }
      if (transfer.callbacks.onResponse) {
        transfer.callbacks.onResponse(
            200,
            {{"Content-Length", std::to_string(data->size())},
             {"Content-Type", "application/octet-stream"}},
            url);
      }
      if (transfer.callbacks.sendIncrementalUpdates &&
          transfer.callbacks.onBodyIncremental) {
        transfer.callbacks.onBodyIncremental(
            0,
            static_cast<int64_t>(data->size()),
            folly::IOBuf::copyBuffer(*data));
      } else if (transfer.callbacks.onBody) {
        transfer.callbacks.onBody(folly::IOBuf::copyBuffer(*data));
      }
      complete("", false);
    } catch (const std::exception& error) {
      complete(std::string("Invalid Blob URL: ") + error.what(), false);
    }
    return;
  }

  CurlHandle curl;
  curl.handle = curl_easy_init();
  if (curl.handle == nullptr) {
    complete("libcurl: could not create an easy handle", false);
    return;
  }

  for (const auto& [name, value] : requestHeaders) {
    const std::string line = name + ": " + value;
    curl.headers = curl_slist_append(curl.headers, line.c_str());
  }

  curl_easy_setopt(curl.handle, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl.handle, CURLOPT_USERAGENT, "react-native-gpui/0.1");
  curl_easy_setopt(curl.handle, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl.handle, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl.handle, CURLOPT_ACCEPT_ENCODING, "");
  curl_easy_setopt(curl.handle, CURLOPT_SHARE, sharedCookies().handle);
  if (requestBody.withCredentials) {
    // Enables libcurl's in-memory cookie engine. Cookie data is shared between
    // requests for the lifetime of the process and is never written to disk.
    curl_easy_setopt(curl.handle, CURLOPT_COOKIEFILE, "");
  }
  curl_easy_setopt(curl.handle, CURLOPT_WRITEFUNCTION, writeCallback);
  curl_easy_setopt(curl.handle, CURLOPT_WRITEDATA, &transfer);
  curl_easy_setopt(curl.handle, CURLOPT_HEADERFUNCTION, headerCallback);
  curl_easy_setopt(curl.handle, CURLOPT_HEADERDATA, &transfer);
  curl_easy_setopt(curl.handle, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(curl.handle, CURLOPT_XFERINFOFUNCTION, progressCallback);
  curl_easy_setopt(curl.handle, CURLOPT_XFERINFODATA, &transfer);
  if (curl.headers != nullptr) {
    curl_easy_setopt(curl.handle, CURLOPT_HTTPHEADER, curl.headers);
  }
  if (timeout > 0) {
    // The interface documents a timeout in seconds, 0 meaning "no timeout".
    curl_easy_setopt(curl.handle, CURLOPT_TIMEOUT, static_cast<long>(timeout));
  }
  if (method != "GET" && method != "get") {
    curl_easy_setopt(curl.handle, CURLOPT_CUSTOMREQUEST, method.c_str());
  }
  std::optional<std::string> requestBodyBlob;
  if (requestBody.formData) {
    curl.mime = curl_mime_init(curl.handle);
    if (curl.mime == nullptr ||
        !addFormData(curl.mime, *requestBody.formData)) {
      complete("Invalid FormData request body", false);
      return;
    }
    curl_easy_setopt(curl.handle, CURLOPT_MIMEPOST, curl.mime);
  } else if (requestBody.blob) {
    auto blob = readBlob(
        requestBody.blob->blobId,
        requestBody.blob->offset,
        requestBody.blob->size);
    if (!blob) {
      complete("Blob request body is no longer available", false);
      return;
    }
    requestBodyBlob = std::move(*blob);
    curl_easy_setopt(curl.handle, CURLOPT_POSTFIELDS, requestBodyBlob->data());
    curl_easy_setopt(
        curl.handle,
        CURLOPT_POSTFIELDSIZE_LARGE,
        static_cast<curl_off_t>(requestBodyBlob->size()));
  } else if (requestBody.base64) {
    auto decoded = decodeBase64(*requestBody.base64);
    if (!decoded) {
      complete("Invalid base64 request body", false);
      return;
    }
    curl_easy_setopt(curl.handle, CURLOPT_POSTFIELDS, decoded->data());
    curl_easy_setopt(
        curl.handle,
        CURLOPT_POSTFIELDSIZE_LARGE,
        static_cast<curl_off_t>(decoded->size()));
  } else if (requestBody.string.has_value()) {
    curl_easy_setopt(
        curl.handle, CURLOPT_POSTFIELDS, requestBody.string->data());
    curl_easy_setopt(
        curl.handle,
        CURLOPT_POSTFIELDSIZE_LARGE,
        static_cast<curl_off_t>(requestBody.string->size()));
  }

  const CURLcode result = curl_easy_perform(curl.handle);

  long responseCode = 0;
  char* effectiveUrlValue = nullptr;
  curl_easy_getinfo(curl.handle, CURLINFO_RESPONSE_CODE, &responseCode);
  curl_easy_getinfo(curl.handle, CURLINFO_EFFECTIVE_URL, &effectiveUrlValue);
  const std::string effectiveUrl =
      effectiveUrlValue == nullptr ? url : effectiveUrlValue;
  curl_easy_cleanup(curl.handle);
  curl.handle = nullptr;

  if (isCancelled(transfer)) {
    complete("Request cancelled", false);
    return;
  }
  if (result != CURLE_OK) {
    const auto error = curl_easy_strerror(result);
    LOG(ERROR) << "[gpui-http] " << method << " " << url
               << " failed: " << error;
    complete(error, result == CURLE_OPERATION_TIMEDOUT);
    return;
  }

  const auto statusCode = static_cast<uint16_t>(responseCode);
  if (transfer.callbacks.onResponse) {
    transfer.callbacks.onResponse(
        statusCode, transfer.responseHeaders, effectiveUrl);
  }
  if (transfer.callbacks.onBody && !transfer.callbacks.sendIncrementalUpdates) {
    transfer.callbacks.onBody(folly::IOBuf::copyBuffer(transfer.body));
  }
  complete("", false);
}

class CurlHttpClient final : public IHttpClient {
 public:
  std::unique_ptr<http::IRequestToken> sendRequest(
      http::NetworkCallbacks&& callbacks,
      const std::string& method,
      const std::string& url,
      const http::Headers& headers = {},
      const http::Body& body = {},
      uint32_t timeout = 0,
      std::optional<std::string> /*loggingId*/ = std::nullopt) override {
    ensureCurlInitialized();

    auto cancellation = std::make_shared<Cancellation>();
    Transfer transfer;
    transfer.cancellation = cancellation;
    transfer.callbacks = std::move(callbacks);

    // The request runs to completion on its own thread: callers block on a
    // future that these callbacks resolve, so the request must not occupy the
    // calling thread.
    std::thread(
        performRequest,
        std::move(transfer),
        method,
        url,
        headers,
        body,
        timeout)
        .detach();

    return std::make_unique<CurlRequestToken>(std::move(cancellation));
  }
};

} // namespace

extern "C" uint64_t rn_gpui_http_requests_in_flight() noexcept {
  return httpRequestsInFlight.load(std::memory_order_relaxed);
}

extern "C" uint64_t rn_gpui_http_requests_not_ignored(
    const char* newline_separated_patterns) noexcept {
  std::lock_guard<std::mutex> lock(httpRequestsMutex);
  uint64_t count = 0;
  for (const auto& [url, active] : httpRequestUrlsInFlight) {
    bool ignored = false;
    if (newline_separated_patterns != nullptr) {
      const std::string patterns(newline_separated_patterns);
      size_t start = 0;
      while (start <= patterns.size()) {
        const auto end = patterns.find('\n', start);
        const auto pattern = patterns.substr(start, end - start);
        if (!pattern.empty() && url.find(pattern) != std::string::npos) {
          ignored = true;
          break;
        }
        if (end == std::string::npos)
          break;
        start = end + 1;
      }
    }
    if (!ignored)
      count += active;
  }
  return count;
}

HttpClientFactory gpui_http_client_factory() {
  return []() -> std::unique_ptr<IHttpClient> {
    return std::make_unique<CurlHttpClient>();
  };
}

bool gpui_http_client_clear_cookies() {
  ensureCurlInitialized();
  CURL* handle = curl_easy_init();
  if (handle == nullptr) {
    return false;
  }
  curl_easy_setopt(handle, CURLOPT_SHARE, sharedCookies().handle);
  curl_easy_setopt(handle, CURLOPT_COOKIEFILE, "");
  const auto result = curl_easy_setopt(handle, CURLOPT_COOKIELIST, "ALL");
  curl_easy_cleanup(handle);
  return result == CURLE_OK;
}

} // namespace rngpui
