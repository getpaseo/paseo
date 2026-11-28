#include "GpuiMountingManager.h"
#include <react/runtime/GpuiDebug.h>

#include <jsi/JSIDynamic.h>
#include <react/renderer/components/desktopcontextmenuview/DesktopContextMenuView.h>
#include <react/renderer/components/desktopscrollbar/DesktopScrollBar.h>
#include <react/renderer/components/desktopswitch/DesktopSwitch.h>
#include <react/renderer/components/nativeroot/NativeRoot.h>
#include <react/renderer/components/nativeslot/NativeSlot.h>
#include <react/renderer/components/shortcutscope/ShortcutScope.h>
#include <react/renderer/components/windowcontrol/WindowControl.h>
#include <atomic>
#include "GpuiHost.h" // KAllSurfacesStopped
#include "GpuiHostComponentsCpp.h"
#include "MountBatchBuilder.h"
#if LOOM_RENDERER
#include "GpuiLoomHost.h"
#endif
#include "react/coremodules/DeviceInfoModule.h"
#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/components/FBReactNativeSpec/ComponentDescriptors.h>
#include <react/renderer/components/FBReactNativeSpec/EventEmitters.h>
#include <react/renderer/components/image/ImageComponentDescriptor.h>
#include <react/renderer/components/image/ImageEventEmitter.h>
#include <react/renderer/components/image/ImageState.h>
#include <react/renderer/components/iostextinput/TextInputComponentDescriptor.h>
#include <react/renderer/components/modal/ModalHostViewShadowNode.h>
#include <react/renderer/components/modal/ModalHostViewState.h>
#include <react/renderer/components/scrollview/ScrollViewComponentDescriptor.h>
#include <react/renderer/components/scrollview/ScrollViewShadowNode.h>
#include <react/renderer/components/text/ParagraphComponentDescriptor.h>
#include <react/renderer/components/text/RawTextComponentDescriptor.h>
#include <react/renderer/components/text/TextComponentDescriptor.h>
#include <react/renderer/components/view/LayoutConformanceComponentDescriptor.h>
#include <react/renderer/components/view/ViewComponentDescriptor.h>
#include <react/renderer/components/view/conversions.h>
#include <react/renderer/components/virtualview/VirtualViewComponentDescriptor.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/imagemanager/ImageResponse.h>

#include <folly/json.h>
#include <glog/logging.h>
#include <atomic>
#include <cstdlib>
#include <string>
#include <string_view>

namespace rngpui {
class GpuiModalHostViewComponentDescriptor final
    : public ConcreteComponentDescriptor<ModalHostViewShadowNode> {
 public:
  using ConcreteComponentDescriptor::ConcreteComponentDescriptor;

  State::Shared createInitialState(
      const Props::Shared& /*props*/,
      const ShadowNodeFamily::Shared& family) const override {
    return std::make_shared<ModalHostViewShadowNode::ConcreteState>(
        std::make_shared<const ModalHostViewState>(
            DeviceInfoModule::windowSize()),
        family);
  }

 protected:
  void adopt(ShadowNode& shadowNode) const override {
    auto& layoutableShadowNode =
        static_cast<YogaLayoutableShadowNode&>(shadowNode);
    auto& stateData =
        static_cast<const ModalHostViewShadowNode::ConcreteState&>(
            *shadowNode.getState())
            .getData();
    layoutableShadowNode.setSize(stateData.screenSize);
    layoutableShadowNode.setPositionType(YGPositionTypeAbsolute);
    ConcreteComponentDescriptor::adopt(shadowNode);
  }
};

void GpuiImageLoader::loadImage(
    const std::string& uri,
    const IImageLoaderOnLoadCallback&& onLoad) {
  const auto requestId = nextRequestId_.fetch_add(1);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    callbacks_.emplace(requestId, std::move(onLoad));
  }
  rn_gpui_load_image(uri, requestId);
}

void GpuiImageLoader::loadWithProgress(
    const std::string& uri,
    GpuiImageProgress&& progress,
    GpuiImageDone&& done) {
  const auto requestId = nextRequestId_.fetch_add(1);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    callbacks_.emplace(requestId, std::move(done));
    progressCallbacks_.emplace(requestId, std::move(progress));
  }
  rn_gpui_load_image(uri, requestId);
}

void GpuiImageLoader::reportProgress(
    std::uint64_t requestId,
    std::int64_t loaded,
    std::int64_t total) {
  GpuiImageProgress callback;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto found = progressCallbacks_.find(requestId);
    if (found == progressCallbacks_.end())
      return;
    callback = found->second;
  }
  callback(
      total > 0 ? static_cast<float>(loaded) / static_cast<float>(total) : 0.f,
      loaded,
      total);
}

IImageLoader::CacheStatus GpuiImageLoader::getCacheStatus(
    const std::string& uri) {
  return rn_gpui_image_is_cached(uri) ? CacheStatus::Memory : CacheStatus::None;
}

void GpuiImageLoader::completeRequest(
    std::uint64_t requestId,
    double width,
    double height,
    const std::string& error) {
  IImageLoaderOnLoadCallback callback;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto found = callbacks_.find(requestId);
    if (found == callbacks_.end())
      return;
    callback = std::move(found->second);
    callbacks_.erase(found);
    progressCallbacks_.erase(requestId);
  }
  callback(width, height, error.empty() ? nullptr : error.c_str());
}

void rn_gpui_on_image_load_result(
    std::uint64_t requestId,
    double width,
    double height,
    rust::String error) {
  GpuiImageLoader::completeRequest(
      requestId, width, height, std::string(error.data(), error.size()));
}

void rn_gpui_on_image_progress(
    std::uint64_t requestId,
    std::int64_t loaded,
    std::int64_t total) {
  GpuiImageLoader::reportProgress(requestId, loaded, total);
}

void installGpuiImageLoadTable() {
  setGpuiImageLoadTable(GpuiImageLoadTable{
      .start = [](const std::string& uri,
                  GpuiImageProgress progress,
                  GpuiImageDone done) {
        GpuiImageLoader::loadWithProgress(
            uri, std::move(progress), std::move(done));
      }});
}

namespace {
// Turns what an image request reports into the Image component's events.
class GpuiImageObserver final : public ImageResponseObserver {
 public:
  GpuiImageObserver(
      std::shared_ptr<const ImageEventEmitter> emitter,
      ImageSource source)
      : emitter_(std::move(emitter)), source_(std::move(source)) {}

  void didReceiveProgress(float progress, int64_t loaded, int64_t total)
      const override {
    emitter_->onProgress(progress, loaded, total);
  }

  void didReceiveImage(const ImageResponse& response) const override {
    auto source = source_;
    if (auto size = std::static_pointer_cast<Size>(response.getImage())) {
      source.size = *size;
      source.scale = 1;
    }
    emitter_->onLoad(source);
    emitter_->onLoadEnd();
  }

  void didReceiveFailure(const ImageLoadError& error) const override {
    ImageErrorInfo info;
    if (auto message =
            std::static_pointer_cast<std::string>(error.getError())) {
      info.error = *message;
    }
    emitter_->onError(info);
    emitter_->onLoadEnd();
  }

 private:
  std::shared_ptr<const ImageEventEmitter> emitter_;
  ImageSource source_;
};

std::atomic<uint64_t> mountBatchesInFlight{0};

const char* kindName(MountKind kind) {
  switch (kind) {
    case MountKind::Create:
      return "Create";
    case MountKind::Delete:
      return "Delete";
    case MountKind::Insert:
      return "Insert";
    case MountKind::Remove:
      return "Remove";
    case MountKind::Update:
      return "Update";
  }
  return "?";
}

std::string describeOp(const MountOp& op) {
  std::string out = std::string("  ") + kindName(op.kind) +
      " tag=" + std::to_string(op.tag) +
      " parent=" + std::to_string(op.parent_tag) +
      " index=" + std::to_string(op.index) + " " + std::string(op.component);
  if (!op.frame.w && !op.frame.h && !op.frame.x && !op.frame.y) {
    return out;
  }
  out += " frame=(" + std::to_string(op.frame.x) + "," +
      std::to_string(op.frame.y) + " " + std::to_string(op.frame.w) + "x" +
      std::to_string(op.frame.h) + ")";
  if (op.has_paragraph) {
    out += " fragments=" + std::to_string(op.paragraph.fragments.size());
  }
  if (!op.extension_props_json.empty()) {
    out += " props=" + std::string(op.extension_props_json);
  }
  return out;
}
} // namespace

void GpuiMountingManager::executeMount(
    SurfaceId surfaceId,
    MountingTransaction&& transaction) {
  applyMutations(surfaceId, transaction.getMutations());
}

void GpuiMountingManager::setComponentState(
    Tag tag,
    std::string_view componentName,
    ComponentHandle componentHandle,
    const State::Shared& state) {
  std::lock_guard<std::mutex> lock(emittersMutex_);
  if (componentName == "ModalHostView") {
    if (auto typed =
            std::dynamic_pointer_cast<const ConcreteState<ModalHostViewState>>(
                state)) {
      modalStates_[tag] = std::move(typed);
    }
  } else if (
      rngpui::anyHostComponents() &&
      rngpui::hostComponentEntry(componentHandle) != nullptr) {
    if (auto typed =
            std::dynamic_pointer_cast<const ConcreteState<GpuiHostStateData>>(
                state)) {
      hostStates_[tag] = std::move(typed);
    }
  }
}

void GpuiMountingManager::clearComponentState(Tag tag) {
  std::lock_guard<std::mutex> lock(emittersMutex_);
  modalStates_.erase(tag);
  hostStates_.erase(tag);
}

void GpuiMountingManager::notifyFrameChanged(
    SurfaceId surfaceId,
    const ShadowView& view) {
  for (const auto& observer : gpuiExtensionHooks().mountObservers) {
    if (observer.onFrameChanged)
      observer.onFrameChanged(surfaceId, view);
  }
}

void GpuiMountingManager::notifyDeleted(Tag tag) {
  for (const auto& observer : gpuiExtensionHooks().mountObservers) {
    if (observer.onDeleted)
      observer.onDeleted(tag);
  }
}

MountBatch GpuiMountingManager::beginBatch(SurfaceId surfaceId) {
  MountBatch batch;
  batch.surface_id = surfaceId;
  if (contentSize_) {
    if (auto size = contentSize_(surfaceId)) {
      if (size->width > 0.f || size->height > 0.f) {
        batch.content_width = size->width;
        batch.content_height = size->height;
        batch.has_content_size = true;
      }
    }
  }
  return batch;
}

void GpuiMountingManager::applyMutations(
    SurfaceId surfaceId,
    const ShadowViewMutationList& mutations) {
  auto batch = beginBatch(surfaceId);
  batch.ops.reserve(mutations.size());
  for (const auto& mutation : mutations) {
    batch.ops.push_back(buildMountOp(mutation));
    observeMutation(surfaceId, mutation);
  }
  submitBatch(surfaceId, std::move(batch));
}

void GpuiMountingManager::observeMutation(
    SurfaceId surfaceId,
    const ShadowViewMutation& mutation) {
  std::lock_guard<std::mutex> lock(emittersMutex_);
  {
    if (mutation.type == ShadowViewMutation::Insert ||
        (mutation.type == ShadowViewMutation::Update &&
         mutation.oldChildShadowView.layoutMetrics.frame !=
             mutation.newChildShadowView.layoutMetrics.frame)) {
      for (const auto& observer : gpuiExtensionHooks().mountObservers) {
        if (observer.onFrameChanged)
          observer.onFrameChanged(surfaceId, mutation.newChildShadowView);
      }
    }
    auto isVisible = [](const ShadowView& shadowView) {
      auto props =
          std::dynamic_pointer_cast<const ModalHostViewProps>(shadowView.props);
      return props && props->visible;
    };
    if (mutation.type == ShadowViewMutation::Insert &&
        std::string_view(mutation.newChildShadowView.componentName) ==
            "ModalHostView" &&
        isVisible(mutation.newChildShadowView)) {
      auto emitter = std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
          mutation.newChildShadowView.eventEmitter);
      if (emitter)
        emitter->onShow({});
    } else if (
        mutation.type == ShadowViewMutation::Update &&
        std::string_view(mutation.oldChildShadowView.componentName) ==
            "ModalHostView" &&
        isVisible(mutation.oldChildShadowView) !=
            isVisible(mutation.newChildShadowView)) {
      auto emitter = std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
          mutation.newChildShadowView.eventEmitter);
      if (emitter) {
        if (isVisible(mutation.newChildShadowView))
          emitter->onShow({});
        else
          emitter->onDismiss({});
      }
    } else if (
        mutation.type == ShadowViewMutation::Delete &&
        std::string_view(mutation.oldChildShadowView.componentName) ==
            "ModalHostView" &&
        isVisible(mutation.oldChildShadowView)) {
      auto emitter = std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
          mutation.oldChildShadowView.eventEmitter);
      if (emitter)
        emitter->onDismiss({});
    }
    if (mutation.type == ShadowViewMutation::Create ||
        mutation.type == ShadowViewMutation::Update) {
      if (!routes_.event) {
        animatedViews_[mutation.newChildShadowView.tag] =
            mutation.newChildShadowView;
        emitters_[mutation.newChildShadowView.tag] =
            mutation.newChildShadowView.eventEmitter;
      }
      const auto componentName =
          std::string(mutation.newChildShadowView.componentName);
      if (componentName == "ScrollView") {
        auto state =
            std::dynamic_pointer_cast<const ConcreteState<ScrollViewState>>(
                mutation.newChildShadowView.state);
        if (state)
          scrollStates_[mutation.newChildShadowView.tag] = std::move(state);
      } else if (
          rngpui::anyHostComponents() &&
          rngpui::hostComponentEntry(
              mutation.newChildShadowView.componentHandle) != nullptr) {
        auto state =
            std::dynamic_pointer_cast<const ConcreteState<GpuiHostStateData>>(
                mutation.newChildShadowView.state);
        if (state) {
          hostStates_[mutation.newChildShadowView.tag] = std::move(state);
        }
      } else if (componentName == "DesktopNativeRoot") {
        auto state =
            std::dynamic_pointer_cast<const ConcreteState<NativeRootState>>(
                mutation.newChildShadowView.state);
        if (state)
          nativeRootStates_[mutation.newChildShadowView.tag] = std::move(state);
      } else if (componentName == "DesktopNativeSlot") {
        auto state =
            std::dynamic_pointer_cast<const ConcreteState<NativeSlotState>>(
                mutation.newChildShadowView.state);
        if (state)
          nativeSlotStates_[mutation.newChildShadowView.tag] = std::move(state);
      } else if (componentName == "ModalHostView") {
        auto state =
            std::dynamic_pointer_cast<const ConcreteState<ModalHostViewState>>(
                mutation.newChildShadowView.state);
        if (state)
          modalStates_[mutation.newChildShadowView.tag] = std::move(state);
      } else if (componentName == "Image") {
        auto state = std::dynamic_pointer_cast<const ConcreteState<ImageState>>(
            mutation.newChildShadowView.state);
        auto emitter = std::dynamic_pointer_cast<const ImageEventEmitter>(
            mutation.newChildShadowView.eventEmitter);
        if (state && emitter) {
          const auto& data = state->getData();
          auto coordinator =
              data.getImageRequest().getSharedObserverCoordinator();
          auto& entry = imageObservations_[mutation.newChildShadowView.tag];
          if (entry.coordinator != coordinator) {
            if (entry.coordinator && entry.observer)
              entry.coordinator->removeObserver(entry.observer);
            entry.coordinator = coordinator;
            entry.observer = std::make_shared<GpuiImageObserver>(
                emitter, data.getImageSource());
            if (data.getImageSource().type != ImageSource::Type::Invalid)
              emitter->onLoadStart();
            coordinator->addObserver(entry.observer);
          }
        }
      }
    } else if (mutation.type == ShadowViewMutation::Delete) {
      for (const auto& observer : gpuiExtensionHooks().mountObservers) {
        if (observer.onDeleted)
          observer.onDeleted(mutation.oldChildShadowView.tag);
      }
      animatedViews_.erase(mutation.oldChildShadowView.tag);
      const auto tag = mutation.oldChildShadowView.tag;
      emitters_.erase(tag);
      scrollStates_.erase(mutation.oldChildShadowView.tag);
      modalStates_.erase(mutation.oldChildShadowView.tag);
      hostStates_.erase(mutation.oldChildShadowView.tag);
      nativeRootStates_.erase(mutation.oldChildShadowView.tag);
      nativeSlotStates_.erase(mutation.oldChildShadowView.tag);
      if (auto found = imageObservations_.find(tag);
          found != imageObservations_.end()) {
        if (found->second.coordinator && found->second.observer)
          found->second.coordinator->removeObserver(found->second.observer);
        imageObservations_.erase(found);
      }
    }
  }
}

void GpuiMountingManager::submitBatch(SurfaceId surfaceId, MountBatch&& batch) {
  if (rn_gpui_log_enabled(0)) {
    rn_gpui_log(
        0,
        "executeMount surface=" + std::to_string(surfaceId) +
            " ops=" + std::to_string(batch.ops.size()));
    for (const auto& op : batch.ops) {
      rn_gpui_log(0, describeOp(op));
    }
  }

  mountBatchesInFlight.fetch_add(1, std::memory_order_relaxed);
  rn_gpui_on_mount(std::move(batch));
  for (const auto& observer : gpuiExtensionHooks().mountObservers) {
    if (observer.afterBatch)
      observer.afterBatch();
  }

  if (onAfterMount_) {
    onAfterMount_(surfaceId);
  }
}

namespace {
std::atomic<uint64_t (*)()> mountPendingProbe{nullptr};
} // namespace

void setMountPendingProbe(uint64_t (*probe)()) {
  mountPendingProbe.store(probe, std::memory_order_release);
}

extern "C" uint64_t rn_gpui_mount_batches_in_flight() noexcept {
  const auto probe = mountPendingProbe.load(std::memory_order_acquire);
  return mountBatchesInFlight.load(std::memory_order_relaxed) +
      (probe != nullptr ? probe() : 0);
}

extern "C" void rn_gpui_mount_batch_applied() noexcept {
  mountBatchesInFlight.fetch_sub(1, std::memory_order_relaxed);
}

void GpuiMountingManager::synchronouslyUpdateViewOnUIThread(
    Tag tag,
    const folly::dynamic& props) {
  if (gpuiDebugAnimationEnabled()) {
    static std::atomic<uint64_t> calls{0};
    const auto call = ++calls;
    if (call <= 5 || call % 60 == 0) {
      LOG(INFO) << "[animated-props] sync tag=" << tag << " call=" << call
                << " props=" << folly::toJson(props);
    }
  }
  // Animation libraries hand colors over as signed 32-bit integers, so a color
  // with a high alpha byte is negative; converting the double straight to
  // unsigned is undefined for those.
  const auto argb = [](const folly::dynamic& value) {
    return static_cast<uint32_t>(
        value.isInt() ? value.asInt() : static_cast<int64_t>(value.asDouble()));
  };
  AnimatedPropsFlat update{};
  update.tag = tag;
  if (props.isObject()) {
    const auto* opacity = props.get_ptr("opacity");
    if (opacity != nullptr && opacity->isNumber()) {
      update.opacity = static_cast<float>(opacity->asDouble());
      update.has_opacity = true;
    }
    const auto* backgroundColor = props.get_ptr("backgroundColor");
    if (backgroundColor != nullptr && backgroundColor->isNumber()) {
      update.background_color = argb(*backgroundColor);
      update.has_background_color = true;
    }
    const auto* textColor = props.get_ptr("color");
    if (textColor != nullptr && textColor->isNumber()) {
      update.text_color = argb(*textColor);
      update.has_text_color = true;
    }
    const auto* transform = props.get_ptr("transform");
    if (transform != nullptr && transform->isArray()) {
      // Use RN's parser and matrix composition, including operation order,
      // layout-dependent translations and transformOrigin. Extracting scalar
      // operations independently loses repeated operations and scale/translate
      // order.
      std::optional<AnimatedGeometry> geometry;
      if (routes_.geometry) {
        geometry = routes_.geometry(tag);
      } else {
        std::lock_guard<std::mutex> lock(emittersMutex_);
        auto it = animatedViews_.find(tag);
        if (it != animatedViews_.end()) {
          if (auto baseProps = std::dynamic_pointer_cast<const BaseViewProps>(
                  it->second.props)) {
            geometry = AnimatedGeometry{
                it->second.layoutMetrics.frame.size,
                baseProps->transformOrigin};
          }
        }
      }
      if (!geometry)
        return;
      ContextContainer contextContainer;
      PropsParserContext context(0, contextContainer);
      Transform parsed;
      fromRawValue(context, RawValue(*transform), parsed);
      update.transform = BaseViewProps::resolveTransform(
                             geometry->size, parsed, geometry->transformOrigin)
                             .matrix;
      update.has_transform = true;
    } else if (props.empty()) {
      update.reset_transform = true;
    }
  }
  if (update.has_opacity || update.has_transform || update.reset_transform ||
      update.has_background_color || update.has_text_color) {
    if (gpuiDebugAnimationEnabled()) {
      static std::atomic<uint64_t> updates{0};
      const auto updateNumber = ++updates;
      if (updateNumber % 60 == 0) {
        LOG(INFO)
            << "[native-animated] applied animated props through Fabric: tag="
            << tag << " count=" << updateNumber << " opacity=" << update.opacity
            << " transform=" << update.has_transform << " scale=("
            << update.transform[0] << ',' << update.transform[5]
            << ") translate=(" << update.transform[12] << ','
            << update.transform[13] << ')';
      }
    }
    rn_gpui_on_animated_props(std::move(update));
  }
}

namespace {
/// The manager host component reports go to. Set once, when the host makes its
/// manager; the two report functions below read it on the main thread.
std::weak_ptr<GpuiMountingManager>& hostComponentStateManager() {
  static std::weak_ptr<GpuiMountingManager> manager;
  return manager;
}
} // namespace

void setHostComponentStateManager(std::weak_ptr<GpuiMountingManager> manager) {
  hostComponentStateManager() = std::move(manager);
}

void reportHostComponentSize(int32_t tag, float width, float height) {
  if (auto manager = hostComponentStateManager().lock()) {
    manager->setHostComponentSize(tag, width, height);
  }
}

bool reportNativeRootSize(
    int32_t tag,
    float height,
    bool hasWidth,
    float width,
    float minWidth) {
#if LOOM_RENDERER
  if (!hasWidth) {
    return GpuiLoomHost::writeMeasuredSize(
        tag, std::nullopt, height, std::nullopt, folly::dynamic::object());
  }
  return GpuiLoomHost::writeMeasuredSize(
      tag,
      width,
      height,
      minWidth,
      folly::dynamic::object("maxWidth", "100%")("flexShrink", 1));
#else
  if (auto manager = hostComponentStateManager().lock()) {
    return manager->setNativeRootSize(tag, height, hasWidth, width, minWidth);
  }
  return false;
#endif
}

bool reportNativeSlotSize(
    int32_t tag,
    bool hasWidth,
    float width,
    bool hasHeight,
    float height) {
#if LOOM_RENDERER
  return GpuiLoomHost::writeMeasuredSize(
      tag,
      hasWidth ? std::optional<float>(width) : std::nullopt,
      hasHeight ? std::optional<float>(height) : std::nullopt,
      std::nullopt,
      folly::dynamic::object());
#else
  if (auto manager = hostComponentStateManager().lock()) {
    return manager->setNativeSlotSize(tag, hasWidth, width, hasHeight, height);
  }
  return false;
#endif
}

void reportHostComponentInsets(
    int32_t tag,
    float top,
    float right,
    float bottom,
    float left) {
  if (auto manager = hostComponentStateManager().lock()) {
    manager->setHostComponentInsets(tag, top, right, bottom, left);
  }
}

void GpuiMountingManager::setHostComponentSize(
    Tag tag,
    float width,
    float height) {
  std::shared_ptr<const ConcreteState<GpuiHostStateData>> state;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = hostStates_.find(tag);
    if (it == hostStates_.end()) {
      return;
    }
    state = it->second;
  }
  const auto& data = state->getData();
  if (data.measured && data.width == width && data.height == height) {
    return;
  }
  GpuiHostStateData next = data;
  next.width = width;
  next.height = height;
  next.measured = true;
  state->updateState(std::move(next));
}

bool GpuiMountingManager::setNativeRootSize(
    Tag tag,
    float height,
    bool hasWidth,
    float width,
    float minWidth) {
  std::shared_ptr<const ConcreteState<NativeRootState>> state;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = nativeRootStates_.find(tag);
    if (it == nativeRootStates_.end()) {
      return false;
    }
    state = it->second;
  }
  NativeRootState next{height, true, width, minWidth, hasWidth};
  const auto& data = state->getData();
  if (data.hasHeight == next.hasHeight && data.height == next.height &&
      data.hasWidth == next.hasWidth && data.width == next.width &&
      data.minWidth == next.minWidth) {
    return true;
  }
  state->updateState(std::move(next));
  return true;
}

bool GpuiMountingManager::setNativeSlotSize(
    Tag tag,
    bool hasWidth,
    float width,
    bool hasHeight,
    float height) {
  std::shared_ptr<const ConcreteState<NativeSlotState>> state;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = nativeSlotStates_.find(tag);
    if (it == nativeSlotStates_.end()) {
      return false;
    }
    state = it->second;
  }
  NativeSlotState next{width, hasWidth, height, hasHeight};
  const auto& data = state->getData();
  if (data.hasWidth == next.hasWidth && data.width == next.width &&
      data.hasHeight == next.hasHeight && data.height == next.height) {
    return true;
  }
  state->updateState(std::move(next));
  return true;
}

void GpuiMountingManager::setHostComponentInsets(
    Tag tag,
    float top,
    float right,
    float bottom,
    float left) {
  std::shared_ptr<const ConcreteState<GpuiHostStateData>> state;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = hostStates_.find(tag);
    if (it == hostStates_.end()) {
      return;
    }
    state = it->second;
  }
  const auto& data = state->getData();
  if (data.insetTop == top && data.insetRight == right &&
      data.insetBottom == bottom && data.insetLeft == left) {
    return;
  }
  GpuiHostStateData next = data;
  next.insetTop = top;
  next.insetRight = right;
  next.insetBottom = bottom;
  next.insetLeft = left;
  state->updateState(std::move(next));
}

void GpuiMountingManager::setScrollOffset(Tag tag, float x, float y) {
  std::shared_ptr<const ConcreteState<ScrollViewState>> state;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = scrollStates_.find(tag);
    if (it == scrollStates_.end())
      return;
    state = it->second;
  }
  const auto& data = state->getData();
  state->updateState(ScrollViewState(
      {x, y}, data.contentBoundingRect, data.scrollAwayPaddingTop));
}

void GpuiMountingManager::setWindowSize(float width, float height) {
  std::vector<std::shared_ptr<const ConcreteState<ModalHostViewState>>> states;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    states.reserve(modalStates_.size());
    for (const auto& [_, state] : modalStates_) {
      states.push_back(state);
    }
  }
  for (const auto& state : states) {
    state->updateState(ModalHostViewState(Size{width, height}));
  }
}

namespace {
std::mutex windowInsetsMutex;
std::array<float, 4> lastWindowInsets{};
} // namespace

void currentWindowInsets(float& top, float& right, float& bottom, float& left) {
  std::lock_guard<std::mutex> lock(windowInsetsMutex);
  top = lastWindowInsets[0];
  right = lastWindowInsets[1];
  bottom = lastWindowInsets[2];
  left = lastWindowInsets[3];
}

void GpuiMountingManager::setWindowTopInset(float top) {
  {
    std::lock_guard<std::mutex> lock(windowInsetsMutex);
    lastWindowInsets = {top, 0.0f, 0.0f, 0.0f};
  }
  for (const auto& observer : gpuiExtensionHooks().windowInsetsObservers) {
    observer(top, 0.0f, 0.0f, 0.0f);
  }
}

void GpuiMountingManager::dispatchEvent(
    Tag tag,
    const std::string& type,
    folly::dynamic&& payload) {
  if (routes_.event) {
    routes_.event(tag, type, std::move(payload));
    return;
  }
  SharedEventEmitter emitter;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = emitters_.find(tag);
    if (it != emitters_.end()) {
      emitter = it->second;
    } else {
      // A JS-driven pop has already unmounted its Fabric listener. Keep the
      // outgoing pixels for animation, but never enqueue events for a dead
      // EventTarget. Native dismissals announce their lifecycle before unmount.
      return;
    }
  }
  if (!emitter) {
    return;
  }
  if (type == "topScroll") {
    // Only the latest scroll position matters: a queued scroll event that JS
    // has not handled yet is replaced rather than piled up behind.
    emitter->dispatchUniqueEvent(type, std::move(payload));
    return;
  }
  emitter->dispatchEvent(type, std::move(payload));
}

void GpuiMountingManager::dispatchWheel(
    Tag tag,
    uint64_t id,
    folly::dynamic&& payload) {
  if (routes_.wheel) {
    routes_.wheel(tag, id, std::move(payload));
    return;
  }
  SharedEventEmitter emitter;
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    auto it = emitters_.find(tag);
    if (it != emitters_.end()) {
      emitter = it->second;
    }
  }
  if (!emitter) {
    rn_gpui_on_wheel_done(id, false);
    return;
  }
  dispatchWheelTo(*emitter, id, std::move(payload));
}

void GpuiMountingManager::dispatchWheelTo(
    const EventEmitter& emitter,
    uint64_t id,
    folly::dynamic&& payload) {
  auto prevented = std::make_shared<std::atomic<bool>>(false);
  auto shared = std::make_shared<folly::dynamic>(std::move(payload));
  emitter.dispatchEvent(
      "topWheel",
      ValueFactory{
          [shared,
           prevented](facebook::jsi::Runtime& runtime) -> facebook::jsi::Value {
            auto value = facebook::jsi::valueFromDynamic(runtime, *shared);
            auto event = value.asObject(runtime);
            auto stop = [prevented](
                            facebook::jsi::Runtime&,
                            const facebook::jsi::Value&,
                            const facebook::jsi::Value*,
                            size_t) -> facebook::jsi::Value {
              prevented->store(true);
              return facebook::jsi::Value::undefined();
            };
            for (const char* name : {"preventDefault", "stopPropagation"}) {
              event.setProperty(
                  runtime,
                  name,
                  facebook::jsi::Function::createFromHostFunction(
                      runtime,
                      facebook::jsi::PropNameID::forAscii(runtime, name),
                      0,
                      stop));
            }
            return value;
          }});
  emitter.dispatchEvent(
      "topWheelEnd",
      ValueFactory{
          [id,
           prevented](facebook::jsi::Runtime& runtime) -> facebook::jsi::Value {
            rn_gpui_on_wheel_done(id, prevented->load());
            return facebook::jsi::Object(runtime);
          }});
}

void GpuiMountingManager::setAccessibilityFocusedView(Tag viewTag) {
  rn_gpui_request_accessibility_focus(viewTag);
}

void GpuiMountingManager::accessibleClickAction(Tag viewTag) {
  dispatchEvent(viewTag, "click", folly::dynamic::object("target", viewTag));
}

void GpuiMountingManager::dispatchCommand(
    const ShadowView& view,
    const std::string& name,
    const folly::dynamic& args) {
  dispatchCommand(
      view.tag, view.componentName, view.componentHandle, name, args);
}

void GpuiMountingManager::dispatchCommand(
    Tag tag,
    std::string_view componentName,
    ComponentHandle componentHandle,
    const std::string& name,
    const folly::dynamic& args) {
  if (componentName == "TextInput") {
    if (name == "focus") {
      rn_gpui_on_text_input_command(tag, true);
    } else if (name == "blur") {
      rn_gpui_on_text_input_command(tag, false);
    } else if (name == "clear") {
      rn_gpui_on_text_input_clear(tag);
    }
    return;
  }
  if (componentName == "View" && (name == "focus" || name == "blur")) {
    rn_gpui_on_text_input_command(tag, name == "focus");
    return;
  }
  const folly::dynamic argsArray =
      args.isArray() ? args : folly::dynamic::array(args);
  rn_gpui_on_builtin_command(
      tag, std::string(componentName), name, folly::toJson(argsArray).c_str());
  if (!rngpui::anyHostComponents()) {
    return;
  }
  const auto* entry = rngpui::hostComponentEntry(componentHandle);
  if (entry == nullptr || entry->command == nullptr) {
    return;
  }
  if (!entry->command(tag, name, argsArray)) {
    LOG(ERROR) << "[host-component] " << entry->name << " has no command '"
               << name << "'";
  }
}

void GpuiMountingManager::setSchedulerTaskExecutor(
    SchedulerTaskExecutor&& executor) noexcept {
  // ReactHost calls this with a real executor when an instance is up
  // (`ReactHost.cpp` createReactInstance) and with `nullptr` when it tears the
  // instance down (destroyReactInstance, which every reload runs through
  // `reloadReactInstance`). Teardown is the only signal the C++ platform gets:
  // `SurfaceManager::stopSurface` → `Scheduler::unregisterSurface` emits no
  // Delete mutations, so the Rust store is told to drop the whole tree itself.
  if (!executor) {
    {
      std::lock_guard<std::mutex> lock(emittersMutex_);
      animatedViews_.clear();
      modalStates_.clear();
      nativeRootStates_.clear();
      nativeSlotStates_.clear();
    }
    if (instanceHook_) {
      instanceHook_(false);
    }
    rn_gpui_on_surface_stopped(kAllSurfacesStopped);
  } else if (instanceHook_) {
    instanceHook_(true);
  }
}

namespace {

std::mutex& knownComponentsMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_set<std::string>& knownComponents() {
  static std::unordered_set<std::string> names;
  return names;
}

void addProvider(
    ComponentDescriptorProviderRegistry& registry,
    const ComponentDescriptorProvider& provider) {
  {
    std::lock_guard<std::mutex> lock(knownComponentsMutex());
    knownComponents().insert(provider.name);
  }
  registry.add(provider);
}

} // namespace

// What `UIManager.hasViewManagerConfig` asks: React Native picks the stable
// `VirtualView` over its experimental twin when the component is registered.
bool GpuiMountingManager::hasComponent(const std::string& name) {
  std::lock_guard<std::mutex> lock(knownComponentsMutex());
  return knownComponents().count(name) > 0;
}

ComponentRegistryFactory GpuiMountingManager::getComponentRegistryFactory() {
  return [](const EventDispatcher::Weak& eventDispatcher,
            const std::shared_ptr<const ContextContainer>& contextContainer) {
    static auto registry = [] {
      auto result = std::make_shared<ComponentDescriptorProviderRegistry>();
      addProvider(
          *result,
          concreteComponentDescriptorProvider<ViewComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              LayoutConformanceComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<ParagraphComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<TextComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<RawTextComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<ImageComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<ScrollViewComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<TextInputComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              GpuiModalHostViewComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              WindowControlComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              DesktopSwitchComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              ActivityIndicatorViewComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              DesktopContextMenuViewComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              ShortcutScopeComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<NativeRootComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<NativeSlotComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              DesktopScrollBarComponentDescriptor>());
      addProvider(
          *result,
          concreteComponentDescriptorProvider<
              VirtualViewComponentDescriptor>());
      result->setComponentDescriptorProviderRequest([](ComponentName name) {
        LOG(ERROR) << "Fabric component " << name
                   << " is not implemented on gpui";
      });
      rn_gpui_register_app_components(*result);
      registerHostComponentDescriptors(*result);
      return result;
    }();
    return registry->createComponentDescriptorRegistry(
        {eventDispatcher, contextContainer, nullptr});
  };
}
} // namespace rngpui
