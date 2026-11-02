/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <functional>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

namespace facebook::react {

class IWebSocketClient {
 public:
  using OnConnectCallback = std::function<void(bool, const std::string &)>;
  using OnClosedCallback = std::function<void(const std::string &)>;
  using OnMessageCallback = std::function<void(const std::string &)>;
  using OnMessageFrameCallback = std::function<void(const std::string &, bool)>;
  using OnClosedFrameCallback = std::function<void(uint16_t, const std::string &)>;

  virtual ~IWebSocketClient() = default;

  virtual void setOnClosedCallback(OnClosedCallback &&callback) noexcept = 0;

  virtual void setOnMessageCallback(OnMessageCallback &&callback) noexcept = 0;

  virtual void setOnMessageFrameCallback(OnMessageFrameCallback &&callback) noexcept {
    setOnMessageCallback([callback = std::move(callback)](const std::string &message) {
      callback(message, false);
    });
  }

  virtual void setOnClosedFrameCallback(OnClosedFrameCallback &&callback) noexcept {
    setOnClosedCallback([callback = std::move(callback)](const std::string &reason) {
      callback(1006, reason);
    });
  }

  virtual void connect(const std::string &url, OnConnectCallback && = nullptr) = 0;

  virtual void close(const std::string &reason) = 0;

  virtual void close(uint16_t code, const std::string &reason) {
    (void)code;
    close(reason);
  }

  virtual void send(const std::string &message) = 0;

  virtual void sendBinary(const std::string &bytes) {
    send(bytes);
  }

  virtual void ping() = 0;
};

extern const char WebSocketClientFactoryKey[];

extern const char DevToolsWebSocketClientFactoryKey[];

using WebSocketClientFactory = std::function<std::unique_ptr<IWebSocketClient>()>;

WebSocketClientFactory getWebSocketClientFactory();

} // namespace facebook::react
