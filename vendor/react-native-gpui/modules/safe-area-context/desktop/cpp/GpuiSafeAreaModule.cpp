#include "GPUISafeAreaInsets.h"
#include "GpuiModules.h"

#include <react/renderer/components/safeareacontext/RNCSafeAreaViewState.h>
#include <react/renderer/core/ConcreteState.h>

#include <folly/json.h>
#include <glog/logging.h>
#include <array>
#include <mutex>
#include <string_view>
#include <unordered_map>

namespace rngpui {
using namespace facebook::react;

namespace {
struct TrackedView {
  std::array<float, 4> frame;
  SharedEventEmitter emitter;
  std::shared_ptr<const ConcreteState<RNCSafeAreaViewState>> state;
};

std::mutex trackedMutex;
std::unordered_map<Tag, TrackedView> tracked;

std::shared_ptr<const ConcreteState<RNCSafeAreaViewState>> safeAreaState(
    const ShadowView& view) {
  if (std::string_view(view.componentName) != "RNCSafeAreaView")
    return nullptr;
  return std::dynamic_pointer_cast<const ConcreteState<RNCSafeAreaViewState>>(
      view.state);
}

void dispatchInsets(
    const SharedEventEmitter& emitter,
    const std::array<float, 4>& frame,
    float top,
    float right,
    float bottom,
    float left) {
  if (!emitter)
    return;
  emitter->dispatchEvent(
      "insetsChange",
      folly::dynamic::object(
          "insets",
          folly::dynamic::object("top", top)("right", right)("bottom", bottom)(
              "left", left))(
          "frame",
          folly::dynamic::object("x", frame[0])("y", frame[1])(
              "width", frame[2])("height", frame[3])));
}

void applyInsets(float top, float right, float bottom, float left) {
  const bool changed = gpui_safe_area::windowTopInset.exchange(top) != top;
  std::vector<std::shared_ptr<const ConcreteState<RNCSafeAreaViewState>>>
      states;
  {
    std::lock_guard<std::mutex> lock(trackedMutex);
    for (const auto& [tag, entry] : tracked) {
      (void)tag;
      if (changed && entry.emitter)
        dispatchInsets(entry.emitter, entry.frame, top, right, bottom, left);
      if (!entry.state)
        continue;
      // The tracked state is the one the view had when its frame last changed.
      // A state update does not move the frame, so it would stay at the old
      // insets, and every batch would send the same update again: one commit
      // per batch, for ever.
      const auto latest =
          std::dynamic_pointer_cast<const ConcreteState<RNCSafeAreaViewState>>(
              entry.state->getMostRecentState());
      const auto& current = latest ? latest : entry.state;
      if (current->getData().insets.top != top)
        states.push_back(current);
    }
  }
  for (const auto& state : states) {
    auto next = state->getData();
    next.insets.top = top;
    state->updateState(std::move(next));
  }
}
} // namespace

void rn_gpui_install_safe_area_module() {
  registerMountObserver(extension::MountObserver{
      .onFrameChanged =
          [](SurfaceId surfaceId, const ShadowView& view) {
            const auto& frame = view.layoutMetrics.frame;
            const std::array<float, 4> nextFrame = {
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height};
            const bool isProvider =
                std::string_view(view.componentName) == "RNCSafeAreaProvider";
            if (!isProvider && !safeAreaState(view))
              return;
            {
              std::lock_guard<std::mutex> lock(trackedMutex);
              auto& entry = tracked[view.tag];
              if (isProvider && entry.emitter && entry.frame == nextFrame)
                return;
              entry.frame = nextFrame;
              entry.emitter = view.eventEmitter;
              entry.state = safeAreaState(view);
            }
            if (!isProvider)
              return;
            const auto insets = gpui_safe_area::gpui_safe_area_insets(
                static_cast<int32_t>(surfaceId));
            LOG(INFO) << "[gpui-safe-area] onInsetsChange tag=" << view.tag
                      << " surface=" << surfaceId << " frame=("
                      << frame.origin.x << ',' << frame.origin.y << ' '
                      << frame.size.width << 'x' << frame.size.height << ')';
            dispatchInsets(
                view.eventEmitter,
                nextFrame,
                insets.top,
                insets.right,
                insets.bottom,
                insets.left);
          },
      .onDeleted =
          [](Tag tag) {
            std::lock_guard<std::mutex> lock(trackedMutex);
            tracked.erase(tag);
          },
      .afterBatch =
          [] {
            applyInsets(
                gpui_safe_area::windowTopInset.load(), 0.0f, 0.0f, 0.0f);
          }});

  registerWindowInsetsObserver(
      [](float top, float right, float bottom, float left) {
        applyInsets(top, right, bottom, left);
      });
}

} // namespace rngpui
