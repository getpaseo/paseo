#pragma once

#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <react/renderer/attributedstring/AttributedString.h>
#include <react/renderer/attributedstring/ParagraphAttributes.h>
#include <react/renderer/attributedstring/TextAttributes.h>
#include <react/renderer/graphics/BackgroundImage.h>
#include <react/renderer/graphics/BackgroundPosition.h>
#include <react/renderer/graphics/BackgroundRepeat.h>
#include <react/renderer/graphics/BackgroundSize.h>
#include <react/renderer/graphics/Color.h>
#include <react/renderer/graphics/Filter.h>
#include <react/renderer/mounting/ShadowViewMutation.h>

#include <cstdint>
#include <string>
#include <vector>

namespace rngpui {
MountOp buildMountOp(const facebook::react::ShadowViewMutation& mutation);

/// A component name as a mount op carries it: interned for the life of the
/// process, so an op names its component without allocating.
rust::Str componentNameStr(const char* name);

// Shared flattening helpers. The text measurement override
// reuses these so React and GPUI describe text identically.
uint32_t argb(const facebook::react::SharedColor& color);
TextFragmentFlat flattenTextFragment(
    const facebook::react::TextAttributes& attributes,
    const std::string& text);

ParagraphFlat flattenParagraphText(
    const facebook::react::AttributedString& attributedString,
    const facebook::react::ParagraphAttributes& attributes,
    bool selectable);

ParagraphFlat flattenInputText(
    const facebook::react::AttributedString& attributedString);

// The JSON the renderer reads for the gradient layers and the filter list.
std::string backgroundJson(
    const std::vector<facebook::react::BackgroundImage>& images,
    const std::vector<facebook::react::BackgroundSize>& sizes,
    const std::vector<facebook::react::BackgroundPosition>& positions,
    const std::vector<facebook::react::BackgroundRepeat>& repeats);
std::string filterJson(
    const std::vector<facebook::react::FilterFunction>& filter);

void installGpuiTextMeasureTable();
void installGpuiImageLoadTable();

} // namespace rngpui
