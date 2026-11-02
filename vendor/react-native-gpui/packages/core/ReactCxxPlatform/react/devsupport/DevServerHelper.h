/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <folly/dynamic.h>
#include <react/http/IHttpClient.h>
#include <react/nativemodule/JavaScriptModule.h>
#include <future>
#include <memory>
#include <string>

namespace facebook::react {

class DevServerHelper {
 public:
  enum class DownloadProgressStatus : short { STARTED, FAILED, FINISHED };
  using DownloadProgressCallback = std::function<void(DownloadProgressStatus)>;

  DevServerHelper(
      std::string appId,
      std::string deviceName,
      std::string devServerHost,
      uint32_t devServerPort,
      const HttpClientFactory &httpClientFactory,
      JavaScriptModuleCallback javaScriptModuleCallback) noexcept;
  ~DevServerHelper() noexcept = default;

  std::future<std::string> downloadBundleResourceSync(
      const std::string &jsBundleUrl,
      DownloadProgressCallback &&downloadProgressCallback = nullptr);

  std::string getInspectorUrl() const;

  std::string getBundleUrl() const;

  std::string getPackagerConnectionUrl() const;

  void openDebugger() const;

  void setSourcePath(const std::string &sourcePath)
  {
    sourcePath_ = sourcePath;
  }

  void setupHMRClient() const;

  // react-native-gpui: the Dev Menu's "Configure Bundler". Every URL this
  // helper hands out is built from these on demand, so the next bundle load
  // and the connections made after it use the new server.
  void setDevServer(std::string host, uint32_t port)
  {
    devServerHost_ = std::move(host);
    devServerPort_ = port;
  }

  const std::string &devServerHost() const
  {
    return devServerHost_;
  }

  uint32_t devServerPort() const
  {
    return devServerPort_;
  }

 private:
  std::string appId_;
  std::string deviceName_;
  std::string devServerHost_;
  uint32_t devServerPort_;
  std::unique_ptr<IHttpClient> httpClient_;
  JavaScriptModuleCallback javaScriptModuleCallback_;
  std::string deviceId_;
  std::string sourcePath_;
};

} // namespace facebook::react
