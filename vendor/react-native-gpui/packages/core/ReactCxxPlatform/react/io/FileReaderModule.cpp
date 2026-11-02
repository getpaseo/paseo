#include "FileReaderModule.h"

#include <react/io/BlobModule.h>
#include <react/utils/Base64.h>
#include <utility>

namespace facebook::react {
namespace {
http::BlobReference readBlobReference(
    jsi::Runtime& rt,
    const jsi::Object& blob) {
  return http::BlobReference{
      .blobId = blob.getProperty(rt, "blobId").asString(rt).utf8(rt),
      .offset = static_cast<uint64_t>(
          blob.getProperty(rt, "offset").asNumber()),
      .size = static_cast<uint64_t>(blob.getProperty(rt, "size").asNumber())};
}
} // namespace

FileReaderModule::FileReaderModule(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeFileReaderModuleCxxSpec(jsInvoker),
      jsInvoker_(std::move(jsInvoker)) {}

AsyncPromise<std::string> FileReaderModule::readAsDataURL(
    jsi::Runtime& rt,
    jsi::Object blob) {
  AsyncPromise<std::string> promise(rt, jsInvoker_);
  const auto reference = readBlobReference(rt, blob);
  const auto bytes = readBlob(reference.blobId, reference.offset, reference.size);
  if (!bytes) {
    promise.reject("Blob data is no longer available");
    return promise;
  }
  const auto type = blob.getProperty(rt, "type").asString(rt).utf8(rt);
  promise.resolve("data:" + type + ";base64," + base64Encode(*bytes));
  return promise;
}

AsyncPromise<std::string> FileReaderModule::readAsText(
    jsi::Runtime& rt,
    jsi::Object blob,
    std::string encoding) {
  AsyncPromise<std::string> promise(rt, jsInvoker_);
  if (encoding != "utf-8" && encoding != "UTF-8" && encoding != "utf8") {
    promise.reject("Only UTF-8 Blob text decoding is currently supported");
    return promise;
  }
  const auto reference = readBlobReference(rt, blob);
  const auto bytes = readBlob(reference.blobId, reference.offset, reference.size);
  if (!bytes) {
    promise.reject("Blob data is no longer available");
  } else {
    promise.resolve(*bytes);
  }
  return promise;
}

} // namespace facebook::react
