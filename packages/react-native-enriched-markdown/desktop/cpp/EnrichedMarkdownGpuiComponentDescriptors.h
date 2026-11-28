#pragma once

#include "EnrichedMarkdownGpuiShadowNodes.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {

using EnrichedMarkdownComponentDescriptor = ConcreteComponentDescriptor<EnrichedMarkdownShadowNode>;
using EnrichedMarkdownTextComponentDescriptor =
    ConcreteComponentDescriptor<EnrichedMarkdownTextShadowNode>;

} // namespace facebook::react
