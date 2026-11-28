// The ImageManager override is compiled as part of ReactCommon, which must not
// see the cxx bridge headers, so it starts loads through this plain
// function-pointer table.
#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace rngpui {
using GpuiImageProgress = std::function<
    void(float progress, std::int64_t loaded, std::int64_t total)>;
using GpuiImageDone = std::function<
    void(double imageWidth, double imageHeight, const char* errorMessage)>;

struct GpuiImageLoadTable {
  // Starts loading `uri`. `progress` may be called any number of times first;
  // `done` is called once, with an error message on failure.
  void (*start)(
      const std::string& uri,
      GpuiImageProgress progress,
      GpuiImageDone done);
};

// Defined in ReactCommonOverrides/.../ImageManager.cpp. Installed once by
// GpuiHost before any surface is started. Without a table a request never
// completes, as before.
void setGpuiImageLoadTable(const GpuiImageLoadTable& table);
const GpuiImageLoadTable* gpuiImageLoadTable();
} // namespace rngpui
