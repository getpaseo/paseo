/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Override: resolved from the include root, because this copy is
// compiled from ReactCommonOverrides/ rather than next to the header.
#include <react/devsupport/DevServerHelper.h>

#include <fmt/format.h>
#include <glog/logging.h>
#include <jsinspector-modern/InspectorFlags.h>
#include <openssl/sha.h>
#include <react/devsupport/inspector/Inspector.h>
#include <react/devsupport/inspector/InspectorPackagerConnectionDelegate.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <iomanip>
#include <regex>

namespace {

// Override: the cxx platform hardcodes the
// Android bundle identifier, which makes Metro serve the Android JS surface.
constexpr std::string_view DEFAULT_PLATFORM = "desktop";

std::string SHA256(const std::string& input) {
  std::array<unsigned char, SHA256_DIGEST_LENGTH> hash{};
  SHA256_CTX sha256;
  SHA256_Init(&sha256);
  SHA256_Update(&sha256, input.c_str(), input.size());
  SHA256_Final(hash.data(), &sha256);
  std::stringstream ss;
  for (unsigned char i : hash) {
    ss << std::hex << std::setw(2) << std::setfill('0') << (int)i;
  }
  return ss.str();
}

std::string urlEscape(const std::string& str) {
  std::regex pattern("[^a-zA-Z0-9._~-]");
  return std::regex_replace(str, pattern, "");
}

} // namespace

namespace facebook::react {

DevServerHelper::DevServerHelper(
    std::string appId,
    std::string deviceName,
    std::string devServerHost,
    uint32_t devServerPort,
    const HttpClientFactory& httpClientFactory,
    JavaScriptModuleCallback javaScriptModuleCallback) noexcept
    : appId_(std::move(appId)),
      deviceName_(std::move(deviceName)),
      devServerHost_(std::move(devServerHost)),
      devServerPort_(devServerPort),
      httpClient_(httpClientFactory()),
      javaScriptModuleCallback_(std::move(javaScriptModuleCallback)) {
  deviceId_ = SHA256(fmt::format("{}-{}", deviceName_, appId_));
}

std::future<std::string> DevServerHelper::downloadBundleResourceSync(
    const std::string& jsBundleUrl,
    DownloadProgressCallback&& downloadProgressCallback) {
  auto promise = std::make_shared<std::promise<std::string>>();
  // What the server said about the response, and whether the promise has been
  // settled: a body that is not a bundle must reject it, and a response that
  // completes without a body must not leave the caller waiting forever.
  struct ResponseState {
    uint16_t status{0};
    std::string contentType;
    std::atomic<bool> settled{false};
  };
  auto state = std::make_shared<ResponseState>();
  auto reject = [promise, state](const std::string& message) {
    if (state->settled.exchange(true)) {
      return;
    }
    LOG(WARNING) << message;
    try {
      throw std::runtime_error(message);
    } catch (...) {
      try {
        promise->set_exception(std::current_exception());
      } catch (...) {
      }
    }
  };
  http::NetworkCallbacks callbacks{
      .onResponse =
          [state](
              uint16_t responseCode,
              http::Headers headers,
              const std::string& /*responseUrl*/) {
            state->status = responseCode;
            for (auto& [name, value] : headers) {
              std::string lower = name;
              std::transform(
                  lower.begin(), lower.end(), lower.begin(), [](char c) {
                    return static_cast<char>(std::tolower(c));
                  });
              if (lower == "content-type") {
                state->contentType = value;
              }
            }
          },
      .onBody =
          [jsBundleUrl, promise, state, reject](
              std::unique_ptr<folly::IOBuf> ioBuf) {
            std::string responseStr = ioBuf->moveToFbString().toStdString();
            // Something other than Metro may be listening on this port (another
            // project's Metro, for example), and Metro itself answers a failed
            // build with a JSON error. Either way the body is not a bundle, and
            // handing it to the engine fails with a syntax error and a blank
            // window. Reject it, so ReactHost falls back to the built-in bundle.
            const bool okStatus = state->status == 0 ||
                (state->status >= 200 && state->status < 300);
            const bool javascriptType = state->contentType.empty() ||
                state->contentType.find("javascript") != std::string::npos;
            const auto first = responseStr.find_first_not_of(" \t\r\n");
            const bool looksLikeData = first != std::string::npos &&
                (responseStr[first] == '{' || responseStr[first] == '<');
            if (!okStatus || !javascriptType || looksLikeData) {
              reject(fmt::format(
                  "The dev server at {} did not return a JS bundle (status {}, "
                  "content type '{}'): {}",
                  jsBundleUrl,
                  state->status,
                  state->contentType,
                  responseStr.substr(0, 300)));
              return;
            }
            if (!state->settled.exchange(true)) {
              promise->set_value(std::move(responseStr));
            }
          },
      .onResponseComplete =
          [jsBundleUrl, promise, state, reject, downloadProgressCallback](
              const std::string& error, bool timeoutError) {
            if (error.empty() && !timeoutError && !state->settled.load()) {
              if (downloadProgressCallback) {
                downloadProgressCallback(DownloadProgressStatus::FAILED);
              }
              reject(
                  "The dev server at " + jsBundleUrl +
                  " returned an empty response");
              return;
            }
            if (!error.empty() || timeoutError) {
              if (downloadProgressCallback) {
                downloadProgressCallback(DownloadProgressStatus::FAILED);
              }
              reject(
                  "Failed to download JS bundle from Url: " + jsBundleUrl +
                  ". Error: " + (error.empty() ? "Timeout" : error));
            } else if (downloadProgressCallback) {
              downloadProgressCallback(DownloadProgressStatus::FINISHED);
            }
          }};
  httpClient_->sendRequest(std::move(callbacks), "GET", jsBundleUrl);
  if (downloadProgressCallback) {
    downloadProgressCallback(DownloadProgressStatus::STARTED);
  }
  return promise->get_future();
}

std::string DevServerHelper::getInspectorUrl() const {
  bool isProfilingBuild =
      jsinspector_modern::InspectorFlags::getInstance().getIsProfilingBuild();

  return fmt::format(
      "ws://{}:{}/inspector/device?name={}&app={}&device={}&profiling={}",
      devServerHost_,
      devServerPort_,
      urlEscape(deviceName_),
      appId_,
      deviceId_,
      isProfilingBuild);
}

std::string DevServerHelper::getBundleUrl() const {
  if (sourcePath_.empty()) {
    return "";
  }

  bool dev = true;
  bool lazy = dev;
  bool minify = false;
  bool splitBundle = false;
  bool modulesOnly = splitBundle;
  bool runModule = !splitBundle;
  return fmt::format(
      "http://{}:{}/{}.bundle?platform={}&dev={}&lazy={}&minify={}&app={}&modulesOnly={}&runModule={}&inlineSourceMap=false&excludeSource=true&sourcePaths=url-server",
      devServerHost_,
      devServerPort_,
      sourcePath_,
      DEFAULT_PLATFORM,
      dev,
      lazy,
      minify,
      appId_,
      modulesOnly,
      runModule);
};

std::string DevServerHelper::getPackagerConnectionUrl() const {
  return fmt::format("ws://{}:{}/message", devServerHost_, devServerPort_);
}

void DevServerHelper::openDebugger() const {
  auto requestUrl = fmt::format(
      "http://{}:{}/open-debugger?device={}",
      devServerHost_,
      devServerPort_,
      deviceId_);
  httpClient_->sendRequest({}, "POST", requestUrl);
}

void DevServerHelper::setupHMRClient() const {
  folly::dynamic params = folly::dynamic::array(
      DEFAULT_PLATFORM,
      sourcePath_,
      devServerHost_,
      devServerPort_,
      true /*enable*/);
  javaScriptModuleCallback_("HMRClient", "setup", std::move(params));
}

} // namespace facebook::react
