#pragma once

#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <react/renderer/attributedstring/TextAttributes.h>
#include <react/renderer/graphics/Color.h>
#include <react/renderer/mounting/ShadowViewMutation.h>

#include <cstdint>
#include <string>

namespace rngpui {
MountOp buildMountOp(const facebook::react::ShadowViewMutation& mutation);

// Shared flattening helpers. The text measurement override
// reuses these so React and GPUI describe text identically.
uint32_t argb(const facebook::react::SharedColor& color);
TextFragmentFlat flattenTextFragment(
    const facebook::react::TextAttributes& attributes,
    const std::string& text);

void installGpuiTextMeasureTable();

} // namespace rngpui
