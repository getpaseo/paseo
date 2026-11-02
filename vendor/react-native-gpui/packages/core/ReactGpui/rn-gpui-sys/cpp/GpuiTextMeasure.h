// The TextLayoutManager override is compiled as part of ReactCommon, which
// must not see the cxx bridge headers, so it calls through this plain
// function-pointer table.
#pragma once

#include <react/renderer/attributedstring/AttributedString.h>
#include <react/renderer/attributedstring/ParagraphAttributes.h>

namespace rngpui {
struct GpuiTextSize {
  float width;
  float height;
};

struct GpuiTextMeasureTable {
  GpuiTextSize (*measureParagraph)(
      const facebook::react::AttributedString& text,
      const facebook::react::ParagraphAttributes& attributes,
      float maxWidth,
      float maxHeight);
};

// Defined in ReactCommonOverrides/.../textlayoutmanager/platform/cxx/.../
// TextLayoutManager.cpp. Installed once by GpuiHost before any surface is
// started. Measuring before that falls back to a zero-sized paragraph, as the
// Rust side does when no measure handler is registered.
void setGpuiTextMeasureTable(const GpuiTextMeasureTable& table);
const GpuiTextMeasureTable* gpuiTextMeasureTable();

} // namespace rngpui
