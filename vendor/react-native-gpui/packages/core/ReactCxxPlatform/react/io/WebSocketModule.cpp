/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "WebSocketModule.h"

#include <react/io/BlobModule.h>
#include <glog/logging.h>
#include <atomic>
#include <mutex>
#include <react/utils/Base64.h>
#include <unordered_map>

namespace facebook::react {

namespace {
std::mutex socketSendersMutex;
std::unordered_map<int32_t, std::function<void(const std::string&)>> socketSenders;

void removeSocketSender(int32_t socketId) {
  std::lock_guard lock(socketSendersMutex);
  socketSenders.erase(socketId);
}
} // namespace

bool sendBlobOverWebSocket(int32_t socketId, const std::string& bytes) {
  std::function<void(const std::string&)> sender;
  {
    std::lock_guard lock(socketSendersMutex);
    auto it = socketSenders.find(socketId);
    if (it == socketSenders.end()) return false;
    sender = it->second;
  }
  sender(bytes);
  return true;
}

WebSocketModule::WebSocketModule(
    std::shared_ptr<CallInvoker> jsInvoker,
    WebSocketClientFactory webSocketClientFactory)
    : NativeWebSocketModuleCxxSpec(jsInvoker),
      webSocketClientFactory_(std::move(webSocketClientFactory)) {}

WebSocketModule::~WebSocketModule() {
  for (const auto& [socketId, _] : connections_) {
    removeSocketSender(socketId);
  }
  connections_.clear();
}

void WebSocketModule::connect(
    jsi::Runtime& /*rt*/,
    const std::string& url,
    const std::optional<std::vector<std::string>>& /*protocols*/,
    jsi::Object /*options*/,
    int32_t socketID) {
  auto webSocket = webSocketClientFactory_();
  connections_.emplace(socketID, std::move(webSocket));
  {
    std::lock_guard lock(socketSendersMutex);
    socketSenders[socketID] = [weakThis = weak_from_this(), socketID](
                                  const std::string& bytes) {
      if (auto strongThis = weakThis.lock()) {
        auto it = strongThis->connections_.find(socketID);
        if (it != strongThis->connections_.end()) {
          it->second->sendBinary(bytes);
        }
      }
    };
  }
  connections_[socketID]->setOnMessageFrameCallback([weakThis = weak_from_this(),
                                                socketID](
                                                   const std::string& message,
                                                   bool isBinary) {
    auto strongThis = weakThis.lock();
    if (!strongThis) {
      return;
    }
    const bool asBlob = isBinary && isBlobWebSocketHandler(socketID);
    static std::atomic<uint64_t> blobSequence{0};
    const auto blobId = asBlob
        ? "gpui-websocket-" + std::to_string(socketID) + "-" +
            std::to_string(blobSequence.fetch_add(1))
        : std::string{};
    if (asBlob) {
      storeBlob(blobId, message);
    }
    strongThis->emitDeviceEvent(
        "websocketMessage",
        [socketID, message = std::string(message), isBinary, asBlob, blobId](
            jsi::Runtime& rt, std::vector<jsi::Value>& args) {
          auto arg = jsi::Object(rt);
          arg.setProperty(rt, "id", jsi::Value(socketID));
          arg.setProperty(
              rt,
              "type",
              facebook::jsi::String::createFromAscii(
                  rt, asBlob ? "blob" : (isBinary ? "binary" : "string")));
          if (asBlob) {
            jsi::Object data(rt);
            data.setProperty(
                rt, "blobId", jsi::String::createFromUtf8(rt, blobId));
            data.setProperty(rt, "offset", 0);
            data.setProperty(rt, "size", static_cast<double>(message.size()));
            data.setProperty(rt, "type", "application/octet-stream");
            arg.setProperty(rt, "data", std::move(data));
          } else {
            arg.setProperty(
                rt,
                "data",
                facebook::jsi::String::createFromUtf8(
                    rt, isBinary ? base64Encode(message) : message));
          }
          args.emplace_back(rt, arg);
        });
  });
  connections_[socketID]->setOnClosedFrameCallback(
      [weakThis = weak_from_this(), socketID](uint16_t code, const std::string& reason) {
        removeSocketSender(socketID);
        setBlobWebSocketHandler(socketID, false);
        auto strongThis = weakThis.lock();
        if (!strongThis) {
          return;
        }
        strongThis->emitDeviceEvent(
            "websocketClosed",
            [socketID, code, reason](jsi::Runtime& rt, std::vector<jsi::Value>& args) {
              auto arg = jsi::Object(rt);
              arg.setProperty(rt, "id", jsi::Value(socketID));
              arg.setProperty(rt, "code", jsi::Value(code));
              arg.setProperty(
                  rt,
                  "reason",
                  facebook::jsi::String::createFromUtf8(rt, reason));
              args.emplace_back(rt, arg);
            });
      });

  connections_[socketID]->connect(
      url,
      [weakThis = weak_from_this(), socketID](
          bool success, const std::optional<std::string>& /*message*/) {
        auto strongThis = weakThis.lock();
        if (!strongThis) {
          return;
        }
        if (success) {
          strongThis->emitDeviceEvent(
              "websocketOpen",
              [socketID](jsi::Runtime& rt, std::vector<jsi::Value>& args) {
                auto arg = jsi::Object(rt);
                arg.setProperty(rt, "id", jsi::Value(socketID));
                args.emplace_back(rt, arg);
              });
        } else {
          strongThis->emitDeviceEvent(
              "websocketFailed",
              [socketID](jsi::Runtime& rt, std::vector<jsi::Value>& args) {
                auto arg = jsi::Object(rt);
                arg.setProperty(rt, "id", jsi::Value(socketID));
                arg.setProperty(
                    rt,
                    "message",
                    facebook::jsi::String::createFromAscii(
                        rt, "Could not connect to websocket."));
                args.emplace_back(rt, arg);
              });
        }
      });
}

void WebSocketModule::send(
    jsi::Runtime& /*rt*/,
    const std::string& message,
    int32_t socketID) {
  auto it = connections_.find(static_cast<int>(socketID));
  if (it == connections_.end()) {
    LOG(ERROR) << "Failed to send data to a socket (" << socketID
               << "), the socket is not open.";
    return;
  }
  it->second->send(message);
}

void WebSocketModule::sendBinary(
    jsi::Runtime& rt,
    const std::string& base64String,
    int32_t forSocketID) {
  auto it = connections_.find(static_cast<int>(forSocketID));
  if (it == connections_.end()) {
    LOG(ERROR) << "Failed to send binary data to a socket (" << forSocketID
               << "), the socket is not open.";
    return;
  }
  std::string decoded;
  decoded.reserve(base64String.size() * 3 / 4);
  uint32_t value = 0;
  int bits = -8;
  for (char ch : base64String) {
    if (ch == '=') break;
    const std::string_view alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto index = alphabet.find(ch);
    if (index == std::string_view::npos) continue;
    value = (value << 6) | static_cast<uint32_t>(index);
    bits += 6;
    if (bits >= 0) {
      decoded.push_back(static_cast<char>((value >> bits) & 0xff));
      bits -= 8;
    }
  }
  it->second->sendBinary(decoded);
}

void WebSocketModule::ping(jsi::Runtime& /*rt*/, int32_t socketID) {
  auto it = connections_.find(static_cast<int>(socketID));
  if (it == connections_.end()) {
    LOG(ERROR) << "Failed to ping a socket (" << socketID
               << "), the socket is not open.";
    return;
  }
  it->second->ping();
}

void WebSocketModule::close(
    jsi::Runtime& /*rt*/,
    int32_t code,
    const std::string& reason,
    int32_t socketID) {
  auto it = connections_.find(static_cast<int>(socketID));
  if (it == connections_.end()) {
    LOG(ERROR) << "Failed to close a socket (" << socketID
               << "), the socket is not open.";
    return;
  }
  it->second->close(static_cast<uint16_t>(code), reason);
  removeSocketSender(socketID);
  setBlobWebSocketHandler(socketID, false);
  connections_.erase(it);
}

void WebSocketModule::addListener(
    jsi::Runtime& /*rt*/,
    const std::string& /*eventName*/) {}

void WebSocketModule::removeListeners(jsi::Runtime& /*rt*/, int32_t /*count*/) {
}

} // namespace facebook::react
