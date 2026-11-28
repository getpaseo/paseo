// Loom's raw view props turned into the flat props the Rust renderer reads,
// without a Fabric `Props` object: the parser visits only the keys a node has
// and converts each value with React Native's own conversions.
#pragma once

#if LOOM_RENDERER

#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <folly/dynamic.h>
#include <react/renderer/components/view/primitives.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/graphics/Size.h>
#include <react/renderer/graphics/Transform.h>
#include <react/renderer/graphics/ValueUnit.h>

#include <cstdint>
#include <memory>

namespace rngpui {

/// What cannot be resolved until the node's frame and direction are known.
/// Allocated only for a node that has such a prop.
struct LoomViewDeps {
  facebook::react::Transform transform;
  facebook::react::TransformOrigin transformOrigin;
  facebook::react::CascadedBorderRadii radii;
  facebook::react::CascadedBorderWidths widths;
  bool radiiPercent{false};
  bool widthsDirectional{false};
};

struct LoomViewFlags {
  /// `Text.selectable`.
  bool selectable{false};
  /// A text node reports its wrapped lines.
  bool onTextLayout{false};
};

/// The groups of `ViewPropsFlat` that `resolveLoomViewLayout` rewrites.
enum LoomLayoutPatch : uint8_t {
  kPatchInsets = 1,
  kPatchWidths = 2,
  kPatchRadii = 4,
  kPatchTransform = 8,
};

/// Sets the props whose unset value is not zero on a value-initialized view:
/// what a node starts as.
void initLoomView(ViewPropsFlat& view);

/// Fills `view` from every key of `props` (the node's whole prop set).
void parseLoomViewProps(
    const facebook::react::PropsParserContext& context,
    const folly::dynamic& props,
    ViewPropsFlat& view,
    LoomViewFlags& flags,
    std::unique_ptr<LoomViewDeps>& deps);

/// Writes what depends on layout into `view`: the groups in `mask` that `deps`
/// governs, and always the content insets and display.
void resolveLoomViewLayout(
    ViewPropsFlat& view,
    const LoomViewDeps* deps,
    const facebook::react::Size& frameSize,
    bool rtl,
    uint8_t mask);

} // namespace rngpui

#endif // LOOM_RENDERER
