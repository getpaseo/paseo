#include "GpuiMountingManager.h"
#include <react/runtime/GpuiDebug.h>

#include <react/renderer/components/desktopcontextmenuview/DesktopContextMenuView.h>
#include <react/renderer/components/nativeviewhost/NativeViewHost.h>
#include <react/renderer/components/shortcutscope/ShortcutScope.h>
#include <react/renderer/components/windowcontrol/WindowControl.h>
#include "GpuiHost.h" // KAllSurfacesStopped
#include "GpuiHostComponentsCpp.h"
#include "MountBatchBuilder.h"
#include "react/coremodules/DeviceInfoModule.h"
#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/components/FBReactNativeSpec/EventEmitters.h>
#include <react/renderer/components/image/ImageComponentDescriptor.h>
#include <react/renderer/components/iostextinput/TextInputComponentDescriptor.h>
#include <react/renderer/components/modal/ModalHostViewShadowNode.h>
#include <react/renderer/components/modal/ModalHostViewState.h>
#include <react/renderer/components/scrollview/ScrollViewComponentDescriptor.h>
#include <react/renderer/components/scrollview/ScrollViewShadowNode.h>
#include <react/renderer/components/text/ParagraphComponentDescriptor.h>
#include <react/renderer/components/text/RawTextComponentDescriptor.h>
#include <react/renderer/components/text/TextComponentDescriptor.h>
#include <react/renderer/components/view/ViewComponentDescriptor.h>
#include <react/renderer/components/view/conversions.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

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

namespace {
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
  {
    std::lock_guard<std::mutex> lock(emittersMutex_);
    for (const auto& mutation : transaction.getMutations()) {
      batch.ops.push_back(buildMountOp(mutation));
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
        auto props = std::dynamic_pointer_cast<const ModalHostViewProps>(
            shadowView.props);
        return props && props->visible;
      };
      if (mutation.type == ShadowViewMutation::Insert &&
          std::string_view(mutation.newChildShadowView.componentName) ==
              "ModalHostView" &&
          isVisible(mutation.newChildShadowView)) {
        auto emitter =
            std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
                mutation.newChildShadowView.eventEmitter);
        if (emitter)
          emitter->onShow({});
      } else if (
          mutation.type == ShadowViewMutation::Update &&
          std::string_view(mutation.oldChildShadowView.componentName) ==
              "ModalHostView" &&
          isVisible(mutation.oldChildShadowView) !=
              isVisible(mutation.newChildShadowView)) {
        auto emitter =
            std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
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
        auto emitter =
            std::dynamic_pointer_cast<const ModalHostViewEventEmitter>(
                mutation.oldChildShadowView.eventEmitter);
        if (emitter)
          emitter->onDismiss({});
      }
      if (mutation.type == ShadowViewMutation::Create ||
          mutation.type == ShadowViewMutation::Update) {
        animatedViews_[mutation.newChildShadowView.tag] =
            mutation.newChildShadowView;
        emitters_[mutation.newChildShadowView.tag] =
            mutation.newChildShadowView.eventEmitter;
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
        } else if (componentName == "ModalHostView") {
          auto state = std::dynamic_pointer_cast<
              const ConcreteState<ModalHostViewState>>(
              mutation.newChildShadowView.state);
          if (state)
            modalStates_[mutation.newChildShadowView.tag] = std::move(state);
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
      }
    }
  }

  rn_gpui_log(
      0,
      "executeMount surface=" + std::to_string(surfaceId) +
          " ops=" + std::to_string(batch.ops.size()));
  for (const auto& op : batch.ops) {
    rn_gpui_log(0, describeOp(op));
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

extern "C" uint64_t rn_gpui_mount_batches_in_flight() noexcept {
  return mountBatchesInFlight.load(std::memory_order_relaxed);
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
      update.background_color =
          static_cast<uint32_t>(backgroundColor->asDouble());
      update.has_background_color = true;
    }
    const auto* textColor = props.get_ptr("color");
    if (textColor != nullptr && textColor->isNumber()) {
      update.text_color = static_cast<uint32_t>(textColor->asDouble());
      update.has_text_color = true;
    }
    const auto* transform = props.get_ptr("transform");
    if (transform != nullptr && transform->isArray()) {
      // Use RN's parser and matrix composition, including operation order,
      // layout-dependent translations and transformOrigin. Extracting scalar
      // operations independently loses repeated operations and scale/translate
      // order.
      ShadowView view;
      {
        std::lock_guard<std::mutex> lock(emittersMutex_);
        auto it = animatedViews_.find(tag);
        if (it == animatedViews_.end())
          return;
        view = it->second;
      }
      auto baseProps =
          std::dynamic_pointer_cast<const BaseViewProps>(view.props);
      if (!baseProps)
        return;
      ContextContainer contextContainer;
      PropsParserContext context(view.surfaceId, contextContainer);
      Transform parsed;
      fromRawValue(context, RawValue(*transform), parsed);
      update.transform =
          BaseViewProps::resolveTransform(
              view.layoutMetrics.frame.size, parsed, baseProps->transformOrigin)
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

void GpuiMountingManager::setWindowTopInset(float top) {
  for (const auto& observer : gpuiExtensionHooks().windowInsetsObservers) {
    observer(top, 0.0f, 0.0f, 0.0f);
  }
}

void GpuiMountingManager::dispatchEvent(
    Tag tag,
    const std::string& type,
    folly::dynamic&& payload) {
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
  if (std::string_view(view.componentName) == "TextInput") {
    if (name == "focus") {
      rn_gpui_on_text_input_command(view.tag, true);
    } else if (name == "blur") {
      rn_gpui_on_text_input_command(view.tag, false);
    } else if (name == "clear") {
      rn_gpui_on_text_input_clear(view.tag);
    }
    return;
  }
  if (!rngpui::anyHostComponents()) {
    return;
  }
  const auto* entry = rngpui::hostComponentEntry(view.componentHandle);
  if (entry == nullptr || entry->command == nullptr) {
    return;
  }
  const folly::dynamic normalized =
      args.isArray() ? args : folly::dynamic::array(args);
  if (!entry->command(view.tag, name, normalized)) {
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
    }
    rn_gpui_on_surface_stopped(kAllSurfacesStopped);
  }
}

ComponentRegistryFactory GpuiMountingManager::getComponentRegistryFactory() {
  return [](const EventDispatcher::Weak& eventDispatcher,
            const std::shared_ptr<const ContextContainer>& contextContainer) {
    static auto registry = [] {
      auto result = std::make_shared<ComponentDescriptorProviderRegistry>();
      result->add(
          concreteComponentDescriptorProvider<ViewComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<ParagraphComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<TextComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<RawTextComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<ImageComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<ScrollViewComponentDescriptor>());
      result->add(
          concreteComponentDescriptorProvider<TextInputComponentDescriptor>());
      result->add(concreteComponentDescriptorProvider<
                  GpuiModalHostViewComponentDescriptor>());
      result->add(concreteComponentDescriptorProvider<
                  NativeViewHostComponentDescriptor>());
      result->add(concreteComponentDescriptorProvider<
                  WindowControlComponentDescriptor>());
      result->add(concreteComponentDescriptorProvider<
                  DesktopContextMenuViewComponentDescriptor>());
      result->add(concreteComponentDescriptorProvider<
                  ShortcutScopeComponentDescriptor>());
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
