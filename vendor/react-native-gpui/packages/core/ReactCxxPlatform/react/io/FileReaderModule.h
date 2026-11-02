#pragma once

#include <FBReactNativeSpec/FBReactNativeSpecJSI.h>
#include <react/bridging/Promise.h>
#include <memory>
#include <string>

namespace facebook::react {

class FileReaderModule final
    : public NativeFileReaderModuleCxxSpec<FileReaderModule> {
 public:
  explicit FileReaderModule(std::shared_ptr<CallInvoker> jsInvoker);

  AsyncPromise<std::string> readAsDataURL(
      jsi::Runtime& rt,
      jsi::Object blob);
  AsyncPromise<std::string> readAsText(
      jsi::Runtime& rt,
      jsi::Object blob,
      std::string encoding);

 private:
  std::shared_ptr<CallInvoker> jsInvoker_;
};

} // namespace facebook::react
