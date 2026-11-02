#pragma once

#include <FBReactNativeSpec/FBReactNativeSpecJSI.h>
#include <react/http/IHttpClient.h>
#include <optional>
#include <string>

namespace facebook::react {

class BlobModule final : public NativeBlobModuleCxxSpec<BlobModule> {
 public:
  explicit BlobModule(std::shared_ptr<CallInvoker> jsInvoker);

  jsi::Object getConstants(jsi::Runtime& rt);
  void addNetworkingHandler(jsi::Runtime& rt);
  void addWebSocketHandler(jsi::Runtime& rt, double socketId);
  void removeWebSocketHandler(jsi::Runtime& rt, double socketId);
  void sendOverSocket(jsi::Runtime& rt, jsi::Object blob, double socketId);
  void createFromParts(jsi::Runtime& rt, jsi::Array parts, std::string blobId);
  void release(jsi::Runtime& rt, std::string blobId);
};

void storeBlob(std::string blobId, std::string bytes);
std::optional<std::string> readBlob(
    const std::string& blobId,
    uint64_t offset,
    uint64_t size);
void eraseBlob(const std::string& blobId);
void setBlobWebSocketHandler(int32_t socketId, bool enabled);
bool isBlobWebSocketHandler(int32_t socketId);
bool sendBlobOverWebSocket(int32_t socketId, const std::string& bytes);

} // namespace facebook::react
