/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "ImageLoaderModule.h"
#include "IImageLoader.h"

namespace facebook::react {

jsi::Object ImageLoaderModule::getConstants(jsi::Runtime& rt) {
  return jsi::Object(rt);
}

void ImageLoaderModule::abortRequest(jsi::Runtime& rt, int32_t requestId) {}

AsyncPromise<std::vector<double>> ImageLoaderModule::getSize(
    jsi::Runtime& rt,
    const std::string& uri) {
  auto promise = AsyncPromise<std::vector<double>>(rt, jsInvoker_);
  if (auto imageLoader = imageLoader_.lock()) {
    imageLoader->loadImage(
        uri,
        [promise](
            double imageWidth,
            double imageHeight,
            const char* errorMessage) mutable {
          if (errorMessage == nullptr) {
            promise.resolve({imageWidth, imageHeight});
          } else {
            promise.reject(errorMessage);
          }
        });
  } else {
    promise.reject("Failed to get image size: image loader is not available.");
  }
  return promise;
}

AsyncPromise<ImageSize> ImageLoaderModule::getSizeWithHeaders(
    jsi::Runtime& rt,
    const std::string& uri,
    jsi::Object /*headers*/) {
  auto promise = AsyncPromise<ImageSize>(rt, jsInvoker_);
  if (auto imageLoader = imageLoader_.lock()) {
    imageLoader->loadImage(uri, [promise](double width, double height, const char* error) mutable {
      if (error == nullptr) promise.resolve({.width = width, .height = height});
      else promise.reject(error);
    });
  } else {
    promise.reject("Failed to get image size: image loader is not available.");
  }
  return promise;
}

AsyncPromise<bool> ImageLoaderModule::prefetchImage(
    jsi::Runtime& rt,
    const std::string& uri) {
  auto promise = AsyncPromise<bool>(rt, jsInvoker_);
  if (auto imageLoader = imageLoader_.lock()) {
    imageLoader->loadImage(
        uri,
        [promise](
            double /*imageWidth*/,
            double /*imageHeight*/,
            const char* errorMessage) mutable {
          if (errorMessage == nullptr) {
            promise.resolve(true);
          } else {
            promise.reject(errorMessage);
          }
        });
  } else {
    promise.reject("Failed to get image size: image loader is not available.");
  }
  return promise;
}

AsyncPromise<bool> ImageLoaderModule::prefetchImageWithMetadata(
    jsi::Runtime& rt,
    const std::string& uri,
    const std::string& /*queryRootName*/,
    int32_t /*rootTag*/) {
  return prefetchImage(rt, uri);
}

jsi::Object ImageLoaderModule::queryCache(
    jsi::Runtime& rt,
    const std::vector<std::string>& uris) {
  auto result = jsi::Object(rt);
  if (auto imageLoader = imageLoader_.lock()) {
    for (const auto& uri : uris) {
      auto cacheStatus = static_cast<int>(imageLoader->getCacheStatus(uri));
      if (cacheStatus == static_cast<int>(IImageLoader::CacheStatus::None)) {
        continue;
      }
      const bool isOnDisk =
          (cacheStatus & static_cast<int>(IImageLoader::CacheStatus::Disk)) !=
          0;
      const bool isInMemory =
          (cacheStatus & static_cast<int>(IImageLoader::CacheStatus::Memory)) !=
          0;

      std::string cacheStatusString;
      if (isOnDisk && isInMemory) {
        cacheStatusString = "disk/memory";
      } else if (isInMemory) {
        cacheStatusString = "memory";
      } else if (isOnDisk) {
        cacheStatusString = "disk";
      }
      result.setProperty(rt, uri.c_str(), cacheStatusString.c_str());
    }
  }
  return result;
}

} // namespace facebook::react
