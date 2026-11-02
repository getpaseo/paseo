/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Upstream's cxx `TextLayoutManager::measure` returns the Yoga minimum size;
// this one measures through the table in GpuiTextMeasure.h.

// This file is compiled from ReactCommonOverrides/, not from next to its
// header, so the include is spelled relative to an include root
// (`${platform_DIR}` = .../textlayoutmanager/platform/cxx/).
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>

#include "GpuiTextMeasure.h" // rngpui::gpuiTextMeasureTable

namespace rngpui {
namespace {
GpuiTextMeasureTable gTextMeasureTable{};
} // namespace

void setGpuiTextMeasureTable(const GpuiTextMeasureTable& table) {
  gTextMeasureTable = table;
}

const GpuiTextMeasureTable* gpuiTextMeasureTable() {
  return gTextMeasureTable.measureParagraph ? &gTextMeasureTable : nullptr;
}

} // namespace rngpui

namespace facebook::react {
TextLayoutManager::TextLayoutManager(
    const std::shared_ptr<const ContextContainer>& contextContainer)
    : contextContainer_(contextContainer), textMeasureCache_(kSimpleThreadSafeCacheSizeCap) {}

TextMeasurement TextLayoutManager::measure(
    const AttributedStringBox& attributedStringBox,
    const ParagraphAttributes& paragraphAttributes,
    const TextLayoutContext& /*layoutContext*/,
    const LayoutConstraints& layoutConstraints) const {
  const auto& fragments = attributedStringBox.getValue().getFragments();

  TextMeasurement::Attachments attachments;
  for (const auto& fragment : fragments) {
    if (fragment.isAttachment()) {
      attachments.push_back(
          TextMeasurement::Attachment{
              .frame = {.origin = {.x = 0, .y = 0}, .size = {.width = 0, .height = 0}},
              .isClipped = false});
    }
  }

  // Without a table (GpuiHost not started yet) measure to zero, the same
  // result the Rust side returns when no measure handler is registered.
  rngpui::GpuiTextSize size{.width = 0, .height = 0};
  if (const auto* table = rngpui::gpuiTextMeasureTable()) {
    size = table->measureParagraph(
        attributedStringBox.getValue(),
        paragraphAttributes,
        layoutConstraints.maximumSize.width,
        layoutConstraints.maximumSize.height);
  }

  return TextMeasurement{
      .size = layoutConstraints.clamp({.width = size.width, .height = size.height}),
      .attachments = std::move(attachments)};
}

} // namespace facebook::react
