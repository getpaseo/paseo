#pragma once

#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/graphics/Geometry.h>
#include <string>

namespace facebook::react {
class EnrichedMarkdownProps;
class EnrichedMarkdownTextProps;
} // namespace facebook::react

extern "C" {
using RnGpuiMarkdownMeasureFn = void (*)(
    const char* snapshot_json,
    float min_width,
    float min_height,
    float max_width,
    float max_height,
    float* out_width,
    float* out_height);

void rn_gpui_markdown_set_measure_fn(RnGpuiMarkdownMeasureFn fn);
}

namespace rngpui::markdown {

std::string serializePropsJson(
    const facebook::react::EnrichedMarkdownProps& props,
    bool isMarkdownContainer);

std::string serializePropsJson(
    const facebook::react::EnrichedMarkdownTextProps& props,
    bool isMarkdownContainer);

facebook::react::Size measureMarkdown(
    const facebook::react::EnrichedMarkdownProps& props,
    bool isMarkdownContainer,
    const facebook::react::LayoutConstraints& layoutConstraints);

facebook::react::Size measureMarkdown(
    const facebook::react::EnrichedMarkdownTextProps& props,
    bool isMarkdownContainer,
    const facebook::react::LayoutConstraints& layoutConstraints);

} // namespace rngpui::markdown
