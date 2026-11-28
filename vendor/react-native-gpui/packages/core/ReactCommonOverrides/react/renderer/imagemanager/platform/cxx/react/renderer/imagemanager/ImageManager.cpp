/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Upstream's cxx `ImageManager::requestImage` returns a request that never
// completes, so no image event is ever sent. This one loads through the table
// in GpuiImageLoad.h and reports progress, completion and failure to the
// request's observers.

#include <react/renderer/imagemanager/ImageManager.h>
#include <react/renderer/imagemanager/ImageResponse.h>
#include <react/renderer/imagemanager/ImageTelemetry.h>
#include <react/renderer/imagemanager/ImageResponseObserverCoordinator.h>

#include "GpuiImageLoad.h" // rngpui::gpuiImageLoadTable

namespace rngpui {
namespace {
GpuiImageLoadTable gImageLoadTable{};
} // namespace

void setGpuiImageLoadTable(const GpuiImageLoadTable& table) {
  gImageLoadTable = table;
}

const GpuiImageLoadTable* gpuiImageLoadTable() {
  return gImageLoadTable.start ? &gImageLoadTable : nullptr;
}
} // namespace rngpui

namespace facebook::react {

ImageManager::ImageManager(
    const std::shared_ptr<const ContextContainer>& /*contextContainer*/) {
  // Silence unused-private-field warning.
  (void)self_;
}

ImageManager::~ImageManager() = default;

ImageRequest ImageManager::requestImage(
    const ImageSource& imageSource,
    SurfaceId surfaceId,
    const ImageRequestParams& /*imageRequestParams*/,
    Tag /*tag*/) const {
  auto telemetry = std::make_shared<ImageTelemetry>(surfaceId);
  ImageRequest request{imageSource, telemetry, {}, {}};
  const auto* table = rngpui::gpuiImageLoadTable();
  if (!table || imageSource.type == ImageSource::Type::Invalid) {
    return request;
  }
  std::weak_ptr<const ImageResponseObserverCoordinator> weak =
      request.getSharedObserverCoordinator();
  table->start(
      imageSource.uri,
      [weak](float progress, int64_t loaded, int64_t total) {
        if (auto coordinator = weak.lock()) {
          coordinator->nativeImageResponseProgress(progress, loaded, total);
        }
      },
      [weak](double width, double height, const char* error) {
        auto coordinator = weak.lock();
        if (!coordinator) {
          return;
        }
        if (error != nullptr) {
          coordinator->nativeImageResponseFailed(
              ImageLoadError(std::make_shared<std::string>(error)));
          return;
        }
        auto size = std::make_shared<Size>(
            Size{static_cast<Float>(width), static_cast<Float>(height)});
        coordinator->nativeImageResponseComplete(ImageResponse(size, nullptr));
      });
  return request;
}

} // namespace facebook::react
