#include "BlobModule.h"

#include <react/io/WebSocketModule.h>
#include <algorithm>
#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace facebook::react {
namespace {
std::mutex blobMutex;
std::unordered_map<std::string, std::string> blobs;
std::unordered_set<int32_t> blobWebSocketHandlers;

http::BlobReference blobReference(jsi::Runtime& rt, const jsi::Object& value) {
  http::BlobReference reference;
  reference.blobId = value.getProperty(rt, "blobId").asString(rt).utf8(rt);
  reference.offset = static_cast<uint64_t>(
      value.getProperty(rt, "offset").asNumber());
  reference.size = static_cast<uint64_t>(
      value.getProperty(rt, "size").asNumber());
  return reference;
}
} // namespace

BlobModule::BlobModule(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeBlobModuleCxxSpec(std::move(jsInvoker)) {}

jsi::Object BlobModule::getConstants(jsi::Runtime& rt) {
  jsi::Object constants(rt);
  constants.setProperty(
      rt, "BLOB_URI_SCHEME", jsi::String::createFromAscii(rt, "blob"));
  constants.setProperty(
      rt, "BLOB_URI_HOST", jsi::String::createFromAscii(rt, "gpui.local"));
  return constants;
}

void BlobModule::addNetworkingHandler(jsi::Runtime& /*rt*/) {}

void BlobModule::addWebSocketHandler(jsi::Runtime& /*rt*/, double socketId) {
  setBlobWebSocketHandler(static_cast<int32_t>(socketId), true);
}

void BlobModule::removeWebSocketHandler(
    jsi::Runtime& /*rt*/,
    double socketId) {
  setBlobWebSocketHandler(static_cast<int32_t>(socketId), false);
}

void BlobModule::sendOverSocket(
    jsi::Runtime& rt,
    jsi::Object blob,
    double socketId) {
  auto reference = blobReference(rt, blob);
  auto bytes = readBlob(reference.blobId, reference.offset, reference.size);
  if (!bytes) {
    throw jsi::JSError(rt, "Blob data is no longer available");
  }
  if (!sendBlobOverWebSocket(static_cast<int32_t>(socketId), *bytes)) {
    throw jsi::JSError(rt, "WebSocket is no longer available");
  }
}

void BlobModule::createFromParts(
    jsi::Runtime& rt,
    jsi::Array parts,
    std::string blobId) {
  std::string bytes;
  for (size_t index = 0; index < parts.size(rt); ++index) {
    auto part = parts.getValueAtIndex(rt, index).asObject(rt);
    auto type = part.getProperty(rt, "type").asString(rt).utf8(rt);
    auto data = part.getProperty(rt, "data");
    if (type == "string") {
      bytes += data.asString(rt).utf8(rt);
    } else if (type == "blob") {
      auto reference = blobReference(rt, data.asObject(rt));
      auto content = readBlob(reference.blobId, reference.offset, reference.size);
      if (!content) {
        throw jsi::JSError(rt, "Blob part data is no longer available");
      }
      bytes += *content;
    } else {
      throw jsi::JSError(rt, "Unsupported Blob part type");
    }
  }
  storeBlob(std::move(blobId), std::move(bytes));
}

void BlobModule::release(jsi::Runtime& /*rt*/, std::string blobId) {
  eraseBlob(blobId);
}

void storeBlob(std::string blobId, std::string bytes) {
  std::lock_guard lock(blobMutex);
  blobs[std::move(blobId)] = std::move(bytes);
}

std::optional<std::string> readBlob(
    const std::string& blobId,
    uint64_t offset,
    uint64_t size) {
  std::lock_guard lock(blobMutex);
  auto it = blobs.find(blobId);
  if (it == blobs.end() || offset > it->second.size()) {
    return std::nullopt;
  }
  const auto available = static_cast<uint64_t>(it->second.size()) - offset;
  const auto length = std::min(size, available);
  return it->second.substr(static_cast<size_t>(offset), static_cast<size_t>(length));
}

void eraseBlob(const std::string& blobId) {
  std::lock_guard lock(blobMutex);
  blobs.erase(blobId);
}

void setBlobWebSocketHandler(int32_t socketId, bool enabled) {
  std::lock_guard lock(blobMutex);
  if (enabled) {
    blobWebSocketHandlers.insert(socketId);
  } else {
    blobWebSocketHandlers.erase(socketId);
  }
}

bool isBlobWebSocketHandler(int32_t socketId) {
  std::lock_guard lock(blobMutex);
  return blobWebSocketHandlers.contains(socketId);
}

} // namespace facebook::react
