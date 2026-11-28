#if LOOM_RENDERER

#include "GpuiLoomHost.h"

#include "GpuiTurboModule.h"
#include "MountBatchBuilder.h"
#include "react/coremodules/DeviceInfoModule.h"
#include "rn-gpui-sys/src/lib.rs.h" // cxx bridge

#include <folly/system/ThreadName.h>
#include <glog/logging.h>
#include <react/loom/Loom.h>
#include <react/renderer/components/image/ImageProps.h>
#include <react/renderer/components/image/ImageShadowNode.h>
#include <react/renderer/components/image/ImageState.h>
#include <react/renderer/components/iostextinput/TextInputProps.h>
#include <react/renderer/components/scrollview/ScrollViewShadowNode.h>
#include <react/renderer/components/scrollview/ScrollViewState.h>
#include <react/renderer/components/text/BaseParagraphProps.h>
#include <react/renderer/components/text/ParagraphEventEmitter.h>
#include <react/renderer/components/text/ParagraphShadowNode.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/components/textinput/TextInputState.h>
#include <react/renderer/components/view/BaseViewProps.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/core/RawProps.h>
#include <react/renderer/core/ShadowNodeFamily.h>
#include <react/renderer/loom/binding/LoomBinding.h>
#include <react/renderer/runtimescheduler/LoomJavaScriptThread.h>
#include <react/renderer/runtimescheduler/LoomSettings.h>

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <iterator>
#include <limits>
#include <thread>
#include <unordered_set>

namespace rngpui {

using namespace facebook::react;

namespace {

// Loom's UI thread when JavaScript runs on its own thread: commit results are
// turned into mount batches here, and the GPUI main thread only applies them,
// so a frame being drawn never delays a commit and a commit never delays a
// frame. With JavaScript on the main thread, the GPUI main thread is Loom's UI
// thread.
class MountThread {
 public:
  static MountThread& shared() {
    static auto* thread = new MountThread();
    return *thread;
  }

  void post(std::function<void()> task) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      tasks_.push_back(std::move(task));
    }
    wake_.notify_one();
  }

  bool isCurrent() const {
    return std::this_thread::get_id() == id_.load(std::memory_order_acquire);
  }

 private:
  MountThread() {
    std::thread([this] {
      folly::setThreadName("loom-mount");
      id_.store(std::this_thread::get_id(), std::memory_order_release);
      for (;;) {
        std::function<void()> task;
        {
          std::unique_lock<std::mutex> lock(mutex_);
          wake_.wait(lock, [this] { return !tasks_.empty(); });
          task = std::move(tasks_.front());
          tasks_.pop_front();
        }
        try {
          task();
        } catch (const std::exception& error) {
          LOG(ERROR) << "Loom mount task failed: " << error.what();
        }
      }
    }).detach();
  }

  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::function<void()>> tasks_;
  std::atomic<std::thread::id> id_{};
};

bool loomUIIsMountThread() {
  return !loomJavaScriptOnUIThread();
}

void postToLoomUI(std::function<void()> task) {
  if (loomUIIsMountThread()) {
    MountThread::shared().post(std::move(task));
  } else {
    dispatchMain(std::move(task));
  }
}

// Threads for Loom's parallel text measurement
// (`LoomPlatformTraits::parallelFor`). One job at a time; the calling thread
// works on it too.
class TextPool {
 public:
  static TextPool& shared() {
    static auto* pool = new TextPool();
    return *pool;
  }

  void run(size_t count, const std::function<void(size_t)>& body) {
    std::lock_guard<std::mutex> serial(runMutex_);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      body_ = &body;
      count_ = count;
      next_ = 0;
      pending_ = count;
      ++generation_;
    }
    wake_.notify_all();
    work();
    std::unique_lock<std::mutex> lock(mutex_);
    done_.wait(lock, [this] { return pending_ == 0; });
    body_ = nullptr;
  }

 private:
  TextPool() {
    const unsigned cores = std::thread::hardware_concurrency();
    const unsigned threads = cores > 3 ? std::min(cores / 2, 4u) : 1u;
    for (unsigned index = 0; index < threads; ++index) {
      std::thread([this] {
        folly::setThreadName("loom-text");
        loop();
      }).detach();
    }
  }

  void loop() {
    uint64_t seen = 0;
    for (;;) {
      {
        std::unique_lock<std::mutex> lock(mutex_);
        wake_.wait(lock, [&] { return generation_ != seen; });
        seen = generation_;
      }
      work();
    }
  }

  void work() {
    for (;;) {
      size_t index;
      const std::function<void(size_t)>* body;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (body_ == nullptr || next_ >= count_) {
          return;
        }
        index = next_++;
        body = body_;
      }
      try {
        (*body)(index);
      } catch (...) {
        // That paragraph stays unmeasured; the layout pass measures it.
      }
      std::lock_guard<std::mutex> lock(mutex_);
      if (--pending_ == 0) {
        done_.notify_all();
      }
    }
  }

  std::mutex runMutex_;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::condition_variable done_;
  const std::function<void(size_t)>* body_{nullptr};
  size_t count_{0};
  size_t next_{0};
  size_t pending_{0};
  uint64_t generation_{0};
};

constexpr size_t kWorkerStackSize = 2 * 1024 * 1024;

void logLoom(LoomLogLevel level, const char* tag, const char* message) {
  const auto line = std::string(tag) + ": " + message;
  rn_gpui_log(level == LoomLogLevel::Warn ? 2 : 1, line);
}

} // namespace

GpuiLoomTextServices::GpuiLoomTextServices(
    std::shared_ptr<const ContextContainer> contextContainer,
    std::shared_ptr<const TextLayoutManager> layoutManager)
    : LoomTextLayoutManagerServices(
          contextContainer,
          layoutManager,
          /*measurableOnWorker=*/true),
      layoutManager_(std::move(layoutManager)),
      contextContainer_(contextContainer) {}

TextAttributes GpuiLoomTextServices::parseTextAttributes(
    SurfaceId surfaceId,
    const std::string& componentName,
    const folly::dynamic& props,
    const TextAttributes& inherited,
    ParagraphAttributes& outParagraphAttributes) {
  // The shadow tree takes the text scale from the layout context; here it is
  // the one input the attributes still lack.
  auto adjusted = inherited;
  adjusted.fontSizeMultiplier = DeviceInfoModule::fontScale();
  if (componentNameByReactViewName(componentName) == "TextInput") {
    // The input's font comes from its own props, as its shadow node reads them.
    static const RawPropsParser parser = [] {
      RawPropsParser prepared;
      prepared.prepare<TextInputProps>();
      return prepared;
    }();
    const PropsParserContext context{surfaceId, *contextContainer_};
    RawProps rawProps{props};
    rawProps.parse(parser);
    const TextInputProps parsed{context, TextInputProps{}, rawProps};
    adjusted.apply(
        parsed.getEffectiveTextAttributes(adjusted.fontSizeMultiplier));
    outParagraphAttributes = parsed.paragraphAttributes;
    return adjusted;
  }
  return LoomTextLayoutManagerServices::parseTextAttributes(
      surfaceId, componentName, props, adjusted, outParagraphAttributes);
}

LoomTextMeasurement GpuiLoomTextServices::prepareText(
    SurfaceId /*surfaceId*/,
    const AttributedString& attributedString,
    const ParagraphAttributes& paragraphAttributes,
    const Size& minimumSize,
    const Size& maximumSize) {
  const auto& fragments = attributedString.getFragments();
  if (fragments.empty() ||
      std::any_of(fragments.begin(), fragments.end(), [](const auto& fragment) {
        return fragment.isAttachment();
      })) {
    return {};
  }
  const auto flat =
      flattenParagraphText(attributedString, paragraphAttributes, false);
  const auto prepared = rn_gpui_prepare_text(flat, maximumSize.width);
  if (prepared.handle == 0) {
    return {};
  }
  LoomTextMeasurement measurement;
  measurement.preparedLayout = std::shared_ptr<void>(
      reinterpret_cast<void*>(prepared.handle), [](void* handle) {
        rn_gpui_release_prepared(reinterpret_cast<std::uintptr_t>(handle));
      });
  LayoutConstraints constraints;
  constraints.minimumSize = minimumSize;
  constraints.maximumSize = maximumSize;
  measurement.size =
      constraints.clamp({.width = prepared.width, .height = prepared.height});
  measurement.valid = true;
  return measurement;
}

LoomTextMeasurement GpuiLoomTextServices::prepareTextForMount(
    SurfaceId surfaceId,
    const AttributedString& attributedString,
    const ParagraphAttributes& paragraphAttributes,
    const Size& minimumSize,
    const Size& maximumSize) {
  return prepareText(
      surfaceId,
      attributedString,
      paragraphAttributes,
      minimumSize,
      maximumSize);
}

GpuiLoomHost::GpuiLoomHost(
    std::shared_ptr<GpuiMountingManager> mountingManager,
    std::shared_ptr<const ContextContainer> contextContainer,
    SchedulerAccess schedulerAccess,
    JsAccess jsAccess)
    : mountingManager_(std::move(mountingManager)),
      contextContainer_(contextContainer),
      schedulerAccess_(std::move(schedulerAccess)),
      jsAccess_(std::move(jsAccess)),
      text_(
          contextContainer,
          std::make_shared<const TextLayoutManager>(contextContainer)),
      imageManager_(std::make_shared<ImageManager>(contextContainer)) {
  active_.store(this, std::memory_order_release);
  setMountPendingProbe(&GpuiLoomHost::pending);
  LoomSettings::configurePlatform(kLoomPlatformDesktop);
  if (std::getenv("RN_GPUI_LOOM_PROFILE") != nullptr) {
    LoomSettings::set(LoomSettingId::ProfileWorker, 1);
  }
}

void GpuiLoomHost::connect() {
  GpuiMountingManager::Routes routes;
  routes.event =
      [weak = weak_from_this()](
          Tag tag, const std::string& type, folly::dynamic&& payload) {
        if (const auto self = weak.lock()) {
          self->dispatchNativeEvent(tag, type, std::move(payload));
        }
      };
  routes.wheel = [weak = weak_from_this()](
                     Tag tag, uint64_t id, folly::dynamic&& payload) {
    if (const auto self = weak.lock()) {
      self->dispatchNativeWheel(tag, id, std::move(payload));
    } else {
      rn_gpui_on_wheel_done(id, false);
    }
  };
  routes.geometry = [weak = weak_from_this()](Tag tag) {
    const auto self = weak.lock();
    return self ? self->animatedGeometry(tag)
                : std::optional<GpuiMountingManager::AnimatedGeometry>{};
  };
  mountingManager_->setRoutes(std::move(routes));
}

GpuiLoomHost::~GpuiLoomHost() {
  auto* expected = this;
  active_.compare_exchange_strong(expected, nullptr);
}

std::uint64_t GpuiLoomHost::pending() {
  std::uint64_t count = pendingUiTasks_.load(std::memory_order_relaxed);
  auto* host = active_.load(std::memory_order_acquire);
  if (host == nullptr) {
    return count;
  }
  // A read never blocks and finds nothing while a commit is being computed.
  if (const auto runtime = loom::Runtime::from(*host->contextContainer_)) {
    runtime->forEachSurface([&](SurfaceId surfaceId) {
      if (!runtime->latest().surfaceSize(surfaceId)) {
        ++count;
      }
    });
  }
  return count;
}

namespace {
// React names components by their view manager (`RCTText`); the descriptor
// registry knows them by Fabric name. The core classifies by the name a node
// was created with, so both spellings are listed.
LoomComponentTable componentTable() {
  using Role = LoomComponentTable::Role;
  auto table = LoomComponentTable::fabric();
  const auto add = [&](const char* name,
                       uint16_t roles,
                       LoomTextStateKind kind = LoomTextStateKind::Other) {
    table.entries[name] = LoomComponentTable::Entry{roles, kind};
  };
  add("RCTView", Role::Box);
  add("RCTText", Role::Paragraph, LoomTextStateKind::Paragraph);
  add("RCTSelectableText",
      Role::Paragraph,
      LoomTextStateKind::SelectableParagraph);
  add("RCTVirtualText", Role::VirtualText);
  add("RCTRawText", Role::RawText);
  add("RCTScrollView", Role::GenericStateWrapper);
  // The core asks for a Fabric name's counterpart among the names JavaScript
  // creates nodes with.
  auto& host = table.hostNames;
  host["View"] = "RCTView";
  host["Image"] = "RCTImageView";
  host["ScrollView"] = "RCTScrollView";
  host["Paragraph"] = "RCTText";
  host["SelectableParagraph"] = "RCTSelectableText";
  host["RawText"] = "RCTRawText";
  table.rawTextHostName = "RCTRawText";
  return table;
}
} // namespace

LoomPlatformTraits GpuiLoomHost::traits() const {
  LoomPlatformTraits traits;
  traits.components = componentTable();
  traits.isUIThread = [] {
    return loomUIIsMountThread() ? MountThread::shared().isCurrent()
                                 : rn_gpui_is_main_thread();
  };
  traits.workerStackSize = kWorkerStackSize;
  traits.workerThreadName = "loom-worker";
  // `sendsPropDiffs` stays null: an update carries every prop, and this host
  // rebuilds a view from `operation.props` and clones compat props from
  // nothing, which a diff would break.
  traits.hasPreparedTextLayout = true;
  traits.liveReadsOnAnyThread = true;
  traits.insertsCarryInitialLayout = true;
  traits.removesSubtreeRootOnly = true;
  traits.parallelFor = [](size_t count,
                          const std::function<void(size_t)>& body) {
    TextPool::shared().run(count, body);
  };
  traits.setCurrentThreadName = [](const char* name) {
    folly::setThreadName(name);
  };
  traits.log = logLoom;
  return traits;
}

std::function<void(std::function<void()>)> GpuiLoomHost::uiExecutor() {
  return [weak = weak_from_this()](std::function<void()> task) {
    pendingUiTasks_.fetch_add(1, std::memory_order_relaxed);
    postToLoomUI([weak, task = std::move(task)] {
      if (const auto self = weak.lock()) {
        std::shared_lock<std::shared_mutex> alive(self->lifetimeMutex_);
        if (self->alive_) {
          task();
        }
      }
      pendingUiTasks_.fetch_sub(1, std::memory_order_relaxed);
    });
  };
}

bool GpuiLoomHost::ensureScheduler() {
  if (registry_ != nullptr && eventManager_ != nullptr) {
    return true;
  }
  schedulerAccess_([this](Scheduler& scheduler) {
    registry_ = scheduler.getComponentDescriptorRegistry();
    if (auto dispatcher = scheduler.getEventDispatcher()) {
      std::lock_guard<std::mutex> events(eventMutex_);
      eventDispatcher_ = dispatcher;
      eventManager_ = std::make_shared<LoomEventManager>(std::move(dispatcher));
    }
  });
  return registry_ != nullptr;
}

GpuiLoomHost::Node* GpuiLoomHost::find(Tag tag) {
  const auto found = nodes_.find(tag);
  return found == nodes_.end() ? nullptr : &found->second;
}

const GpuiLoomHost::ComponentInfo* GpuiLoomHost::componentInfo(
    const std::string& name) {
  const auto found = components_.find(name);
  if (found != components_.end()) {
    return found->second.descriptor != nullptr ? &found->second : nullptr;
  }
  ComponentInfo info;
  try {
    const auto& descriptor = registry_->at(name);
    info.descriptor = &descriptor;
    info.name = descriptor.getComponentName();
    info.opName = componentNameStr(info.name);
    info.handle = descriptor.getComponentHandle();
    info.traits = descriptor.getTraits();
    const std::string_view fabricName = info.name;
    info.kind = fabricName == "View"    ? Kind::View
        : fabricName == "Paragraph"     ? Kind::Paragraph
        : fabricName == "Image"         ? Kind::Image
        : fabricName == "ScrollView"    ? Kind::ScrollView
        : fabricName == "TextInput"     ? Kind::TextInput
        : fabricName == "ModalHostView" ? Kind::Modal
                                        : Kind::Compat;
    if (info.kind == Kind::Compat) {
      if (rngpui::anyHostComponents()) {
        info.host = rngpui::hostComponentEntry(info.handle);
      }
      const auto& hooks = gpuiExtensionHooks().componentProps;
      if (const auto hook = hooks.find(std::string(fabricName));
          hook != hooks.end()) {
        info.hook = &hook->second;
      }
    }
  } catch (const std::exception& error) {
    LOG(ERROR) << "Loom: no component descriptor for " << name << ": "
               << error.what();
  }
  const auto inserted = components_.emplace(name, info).first;
  return info.descriptor != nullptr ? &inserted->second : nullptr;
}

void GpuiLoomHost::markDirty(Node& node, Tag tag, std::uint8_t bits) {
  node.dirty |= bits;
  if ((node.dirty & kQueued) == 0) {
    node.dirty |= kQueued;
    dirtyTags_.push_back(tag);
  }
}

EventEmitter::Shared GpuiLoomHost::makeEmitter(const Node& node, Tag tag) {
  InstanceHandle::Shared handle;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    const auto found = instanceHandles_.find(tag);
    if (found == instanceHandles_.end()) {
      return nullptr;
    }
    handle = found->second.handle;
  }
  auto family = node.info->descriptor->createFamily(
      ShadowNodeFamilyFragment{tag, node.surfaceId, std::move(handle)});
  auto emitter = family->getEventEmitter();
  emitter->getEventTarget()->setEnabled(true);
  families_[tag] = std::move(family);
  return emitter;
}

// What a mount observer or a prop extractor reads of a node: its identity,
// geometry and, for a compat component, its typed props and state.
ShadowView GpuiLoomHost::lightView(const Node& node, Tag tag) const {
  ShadowView view;
  view.componentName = node.info->name;
  view.componentHandle = node.info->handle;
  view.traits = node.info->traits;
  view.surfaceId = node.surfaceId;
  view.tag = tag;
  auto& metrics = view.layoutMetrics;
  metrics.frame = {
      {node.frame[0], node.frame[1]}, {node.frame[2], node.frame[3]}};
  metrics.displayType = static_cast<DisplayType>(node.displayType);
  metrics.layoutDirection = node.direction == 2 ? LayoutDirection::RightToLeft
                                                : LayoutDirection::LeftToRight;
  metrics.pointScaleFactor = pointScaleFactor_;
  metrics.contentInsets = {
      node.insets[0], node.insets[1], node.insets[2], node.insets[3]};
  if (node.compat) {
    view.props = node.compat->props;
    view.state = node.compat->state;
  }
  return view;
}

namespace {
// Turns what an image request reports into the Image component's events.
class LoomImageObserver final : public ImageResponseObserver {
 public:
  LoomImageObserver(
      std::weak_ptr<GpuiLoomHost> host,
      Tag tag,
      ImageSource source)
      : host_(std::move(host)), tag_(tag), source_(std::move(source)) {}

  void didReceiveProgress(float progress, int64_t loaded, int64_t total)
      const override {
    send(
        "topProgress",
        folly::dynamic::object("progress", progress)(
            "loaded", static_cast<double>(loaded))(
            "total", static_cast<double>(total)));
  }

  void didReceiveImage(const ImageResponse& response) const override {
    auto source = source_;
    if (auto size = std::static_pointer_cast<Size>(response.getImage())) {
      source.size = *size;
      source.scale = 1;
    }
    send(
        "topLoad",
        folly::dynamic::object(
            "source",
            folly::dynamic::object("uri", source.uri)(
                "width", source.size.width * source.scale)(
                "height", source.size.height * source.scale)));
    send("topLoadEnd", folly::dynamic::object());
  }

  void didReceiveFailure(const ImageLoadError& error) const override {
    folly::dynamic payload = folly::dynamic::object();
    if (auto message = std::static_pointer_cast<std::string>(error.getError());
        message && !message->empty()) {
      payload["error"] = *message;
    }
    send("topError", std::move(payload));
    send("topLoadEnd", folly::dynamic::object());
  }

 private:
  void send(const char* type, folly::dynamic&& payload) const {
    if (const auto host = host_.lock()) {
      host->dispatchTargetEvent(tag_, type, std::move(payload));
    }
  }

  std::weak_ptr<GpuiLoomHost> host_;
  Tag tag_;
  ImageSource source_;
};
} // namespace

// An Image asks for its picture at the size it was laid out at, and again when
// the size or the source changes.
void GpuiLoomHost::syncImage(Node& node, Tag tag) {
  auto& ext = *node.ext;
  const Size contentSize{
      std::max(0.f, node.frame[2] - node.insets[0] - node.insets[2]),
      std::max(0.f, node.frame[3] - node.insets[1] - node.insets[3])};
  const auto scale = pointScaleFactor_;
  ImageSource source{ImageSource::Type::Invalid};
  if (ext.sources.size() == 1) {
    source = ext.sources.front();
    source.size = contentSize;
    source.scale = scale;
  } else if (!ext.sources.empty()) {
    const auto targetArea =
        contentSize.width * contentSize.height * scale * scale;
    auto bestFit = std::numeric_limits<Float>::infinity();
    for (const auto& candidate : ext.sources) {
      const auto candidateScale =
          candidate.scale == 0 ? scale : candidate.scale;
      const auto candidateArea = candidate.size.width * candidate.size.height *
          candidateScale * candidateScale;
      const auto fit = std::abs(1 - candidateArea / targetArea);
      if (fit < bestFit) {
        bestFit = fit;
        source = candidate;
      }
    }
    source.size = contentSize;
    source.scale = scale;
  }
  const ImageRequestParams params{ext.blurRadius};
  if (ext.requested && *ext.requested == source &&
      ext.requestedParams == params) {
    return;
  }
  if (const auto found = imageObservations_.find(tag);
      found != imageObservations_.end()) {
    found->second.coordinator->removeObserver(found->second.observer);
    imageObservations_.erase(found);
  }
  ext.request = std::make_unique<ImageRequest>(
      imageManager_->requestImage(source, node.surfaceId, params, tag));
  ext.requested = source;
  ext.requestedParams = params;
  auto coordinator = ext.request->getSharedObserverCoordinator();
  auto observer =
      std::make_shared<LoomImageObserver>(weak_from_this(), tag, source);
  if (source.type != ImageSource::Type::Invalid) {
    dispatchTargetEvent(tag, "topLoadStart", folly::dynamic::object());
  }
  coordinator->addObserver(observer);
  imageObservations_[tag] = {std::move(coordinator), std::move(observer)};
}

void GpuiLoomHost::reportModal(Node& node, Tag tag, bool visible) {
  if (node.ext->shown == visible) {
    return;
  }
  node.ext->shown = visible;
  dispatchTargetEvent(
      tag, visible ? "topShow" : "topDismiss", folly::dynamic::object());
}

void GpuiLoomHost::drop(Tag tag) {
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    earlyLayouts_.erase(tag);
    pendingEvents_.erase(tag);
  }
  decltype(nodes_)::node_type node;
  {
    std::lock_guard<std::mutex> scroll(scrollMutex_);
    node = nodes_.extract(tag);
    scrollOffsets_.erase(tag);
  }
  viewless_.erase(tag);
  pendingEffects_.erase(tag);
  mountingManager_->clearComponentState(tag);
  if (const auto found = imageObservations_.find(tag);
      found != imageObservations_.end()) {
    found->second.coordinator->removeObserver(found->second.observer);
    imageObservations_.erase(found);
  }
}

// A node that goes away while the mounting side still holds it is deleted
// there first.
void GpuiLoomHost::retire(Tag tag) {
  auto* node = find(tag);
  if (node != nullptr && node->created) {
    if (node->ext && node->info->kind == Kind::Modal) {
      reportModal(*node, tag, false);
    }
    structural_.push_back(
        {Structural::Delete,
         node->surfaceId,
         tag,
         -1,
         -1,
         node->info,
         node->ext ? node->ext->sent : std::string{}});
  }
  drop(tag);
}

void GpuiLoomHost::parseView(
    const PropsParserContext& context,
    Node& node,
    const folly::dynamic& props) {
  const bool wasSelectable = node.flags.selectable;
  node.deps.reset();
  node.flags = {};
  auto view = std::make_unique<ViewPropsFlat>();
  initLoomView(*view);
  parseLoomViewProps(context, props, *view, node.flags, node.deps);
  node.parsed = std::move(view);
  if (node.created && wasSelectable != node.flags.selectable) {
    node.dirty |= kSelectable;
  }
  switch (node.info->kind) {
    case Kind::Image: {
      auto image = parseLoomImage(context, props);
      node.ext->body = std::move(image.body);
      node.ext->sources = std::move(image.sources);
      node.ext->blurRadius = image.blurRadius;
      break;
    }
    case Kind::ScrollView:
      node.ext->body = parseLoomScrollView(context, props);
      break;
    case Kind::TextInput: {
      auto input = parseLoomTextInput(context, props);
      node.ext->body = std::move(input.body);
      // An empty input has no fragment, so the placeholder and the caret would
      // not know the font and color the typed text will have.
      ParagraphAttributes attributes;
      auto attrs = text_.parseTextAttributes(
          node.surfaceId, "TextInput", props, TextAttributes{}, attributes);
      attrs.fontSizeMultiplier = 1.f;
      node.ext->fallback = flattenTextFragment(attrs, "");
      break;
    }
    case Kind::Modal: {
      node.ext->visible = parseLoomModalVisible(props);
      JsonBody json;
      json.boolean("visible", node.ext->visible);
      node.ext->body = json.body();
      break;
    }
    default:
      break;
  }
}

void GpuiLoomHost::onCreate(
    const PropsParserContext& context,
    const DirectCreateOperation& operation) {
  const auto tag = operation.tag;
  if (find(tag) != nullptr) {
    retire(tag);
  }
  viewless_.erase(tag);
  if (!operation.layoutable) {
    viewless_.insert(tag);
    pendingEffects_.erase(tag);
    return;
  }
  const auto* info = componentInfo(operation.componentName);
  if (info == nullptr) {
    viewless_.insert(tag);
    pendingEffects_.erase(tag);
    return;
  }
  Node node;
  node.surfaceId = context.surfaceId;
  node.info = info;
  PendingEffects pending;
  bool hasPending = false;
  if (const auto found = pendingEffects_.find(tag);
      found != pendingEffects_.end()) {
    pending = std::move(found->second);
    pendingEffects_.erase(found);
    hasPending = true;
  }
  const bool carriesExt = info->kind != Kind::View &&
      info->kind != Kind::Paragraph &&
      (info->kind != Kind::Compat || info->hook != nullptr);
  if (carriesExt) {
    node.ext = std::make_unique<Ext>();
  }
  if (info->kind == Kind::Compat) {
    node.compat = std::make_unique<Compat>();
    node.compat->props = operation.parsedProps != nullptr
        ? operation.parsedProps
        : info->descriptor->cloneProps(
              context, nullptr, RawProps(operation.props));
    if (hasPending) {
      node.compat->state = pending.state;
    }
    node.compat->emitter = makeEmitter(node, tag);
  }
  if (hasPending && pending.state) {
    mountingManager_->setComponentState(
        tag, info->name, info->handle, pending.state);
  }
  parseView(context, node, operation.props);
  if (hasPending) {
    if (pending.text) {
      node.text = std::move(pending.text);
    }
    if (node.ext && pending.hasScrollState) {
      node.ext->hasScrollState = true;
      node.ext->offset = pending.offset;
      node.ext->content = pending.content;
    }
  }
  Node* stored = nullptr;
  {
    std::lock_guard<std::mutex> scroll(scrollMutex_);
    stored = &nodes_.emplace(tag, std::move(node)).first->second;
  }
  markDirty(*stored, tag, 0);
}

void GpuiLoomHost::onUpdateProps(
    const PropsParserContext& context,
    const DirectUpdatePropsOperation& operation) {
  auto* node = find(operation.tag);
  if (node == nullptr) {
    return;
  }
  if (node->compat) {
    node->compat->props = operation.parsedProps != nullptr
        ? operation.parsedProps
        : node->info->descriptor->cloneProps(
              context, nullptr, RawProps(operation.props));
  }
  parseView(context, *node, operation.props);
  markDirty(*node, operation.tag, 0);
}

void GpuiLoomHost::applyBatch(SurfaceId surfaceId, LoomMountBatch batch) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (!ensureScheduler()) {
    return;
  }
  const PropsParserContext context{surfaceId, *contextContainer_};

  // A tag deleted and created again in one batch: the old node goes first, and
  // the delete that follows must leave the new one alone.
  std::unordered_set<Tag> replaced;
  if (batch.requiresTagReplacement) {
    std::unordered_set<Tag> deleted;
    for (const auto index :
         batch.phaseOperationIndexes[LoomMountBatch::Deletes]) {
      deleted.insert(
          std::get<DirectDeleteOperation>(batch.operations[index]).tag);
    }
    for (const auto index :
         batch.phaseOperationIndexes[LoomMountBatch::CreateAndProps]) {
      if (const auto* created =
              std::get_if<DirectCreateOperation>(&batch.operations[index])) {
        if (deleted.count(created->tag) != 0) {
          replaced.insert(created->tag);
        }
      }
    }
    for (const auto tag : replaced) {
      retire(tag);
    }
  }

  const auto layout = [&](Tag tag,
                          Tag parent,
                          int displayType,
                          int layoutDirection,
                          float x,
                          float y,
                          float width,
                          float height) {
    auto* node = find(tag);
    if (node == nullptr) {
      return;
    }
    const std::array<float, 4> frame{x, y, width, height};
    std::uint8_t bits = 0;
    {
      std::lock_guard<std::mutex> scroll(scrollMutex_);
      if (node->frame != frame) {
        node->frame = frame;
        bits |= kFrame;
      }
      node->parent = parent;
      node->laidOut = true;
    }
    if (node->displayType != displayType) {
      node->displayType = static_cast<std::uint8_t>(displayType);
      bits |= kDisplay;
    }
    if (node->direction != layoutDirection) {
      node->direction = static_cast<std::uint8_t>(layoutDirection);
      bits |= kDirection;
    }
    if (bits != 0) {
      markDirty(*node, tag, bits);
    }
  };

  auto apply = [&](const auto& operation) {
    using Operation = std::decay_t<decltype(operation)>;
    if constexpr (std::is_same_v<Operation, DirectCreateOperation>) {
      onCreate(context, operation);
    } else if constexpr (std::
                             is_same_v<Operation, DirectUpdatePropsOperation>) {
      onUpdateProps(context, operation);
    } else if constexpr (std::is_same_v<Operation, DirectRemoveOperation>) {
      if (auto* node = find(operation.tag); node != nullptr && node->created) {
        structural_.push_back(
            {Structural::Remove,
             node->surfaceId,
             operation.tag,
             operation.parentTag,
             static_cast<std::int32_t>(operation.index),
             node->info,
             {}});
      }
    } else if constexpr (std::is_same_v<Operation, DirectInsertOperation>) {
      if (auto* node = find(operation.tag)) {
        {
          std::lock_guard<std::mutex> scroll(scrollMutex_);
          node->parent = operation.parentTag;
        }
        if (operation.hasLayout) {
          layout(
              operation.tag,
              operation.parentTag,
              operation.displayType,
              operation.layoutDirection,
              operation.x,
              operation.y,
              operation.width,
              operation.height);
          if (node->created) {
            node->layoutBits |= kInsertLayout;
          }
        }
        structural_.push_back(
            {Structural::Insert,
             node->surfaceId,
             operation.tag,
             operation.parentTag,
             static_cast<std::int32_t>(operation.index),
             node->info,
             {}});
      }
    } else if constexpr (std::is_same_v<Operation, DirectPaddingOperation>) {
      if (auto* node = find(operation.tag);
          node != nullptr && node->insets != operation.insets) {
        node->insets = operation.insets;
        markDirty(*node, operation.tag, kInsets);
      }
    } else if constexpr (std::is_same_v<Operation, DirectLayoutOperation>) {
      layout(
          operation.tag,
          operation.parentTag,
          operation.displayType,
          operation.layoutDirection,
          operation.x,
          operation.y,
          operation.width,
          operation.height);
    } else if constexpr (std::is_same_v<Operation, DirectDeleteOperation>) {
      if (replaced.count(operation.tag) == 0) {
        retire(operation.tag);
      }
    }
    // Overflow insets do not reach the Rust store.
  };

  for (const auto& phase : batch.phaseOperationIndexes) {
    for (const auto index : phase) {
      std::visit(apply, batch.operations[index]);
    }
  }
  flushLocked();
}

namespace {

// Keeps a scratch vector's capacity for the next flush, unless a much larger
// past flush left it: a large mount must not pin its peak.
template <class T>
void releaseScratch(std::vector<T>& scratch) {
  constexpr size_t kKeep = 4096;
  if (scratch.capacity() > kKeep && scratch.size() * 8 < scratch.capacity()) {
    std::vector<T> smaller;
    smaller.reserve(std::max(kKeep, scratch.size() * 2));
    std::move(scratch.begin(), scratch.end(), std::back_inserter(smaller));
    scratch = std::move(smaller);
  }
}

} // namespace

// Delivers the tree changes the operations recorded, then a create or an update
// for every node that changed, as one batch per surface.
void GpuiLoomHost::flushLocked() {
  flushScheduled_ = false;
  // Taken out of the members, so a flush that runs inside this one (an event
  // delivered synchronously) gets its own.
  auto batches = std::move(batches_);
  auto updates = std::move(updates_);
  auto insertLayouts = std::move(insertLayouts_);
  batches.clear();
  updates.clear();
  insertLayouts.clear();
  const auto batchOf = [&](SurfaceId surfaceId) -> MountBatch& {
    for (auto& [id, batch] : batches) {
      if (id == surfaceId) {
        return batch;
      }
    }
    auto& batch =
        batches.emplace_back(surfaceId, mountingManager_->beginBatch(surfaceId))
            .second;
    // At most one op per tree change and per changed node; sized once so a
    // large mount does not grow the vector (and copy its ops) a dozen times.
    if (batches.size() == 1) {
      batch.ops.reserve(structural_.size() + dirtyTags_.size());
    }
    return batch;
  };
  const bool observed = !gpuiExtensionHooks().mountObservers.empty();

  const auto structuralOp = [&](Structural& entry) {
    auto& ops = batchOf(entry.surfaceId).ops;
    ops.emplace_back();
    auto& op = ops.back();
    op.kind = entry.kind == Structural::Remove ? MountKind::Remove
        : entry.kind == Structural::Insert     ? MountKind::Insert
                                               : MountKind::Delete;
    op.tag = entry.tag;
    op.parent_tag = entry.parent;
    op.index = entry.index;
    op.component = entry.info->opName;
    op.host_index = -1;
    if (entry.kind == Structural::Insert) {
      if (auto* node = find(entry.tag)) {
        op.frame = {
            node->frame[0], node->frame[1], node->frame[2], node->frame[3]};
        if (node->ext) {
          op.extension_props_json = node->ext->sent;
        }
        if ((node->layoutBits & kInsertLayoutQueued) != 0) {
          const auto dirty = node->dirty;
          node->dirty = 0;
          node->layoutBits &= kWaited;
          op.layout_changed = (dirty & kFrame) != 0;
          buildViewOp(*node, dirty, op);
        }
        if (observed) {
          mountingManager_->notifyFrameChanged(
              entry.surfaceId, lightView(*node, entry.tag));
        }
      }
    } else if (entry.kind == Structural::Delete) {
      op.extension_props_json = std::move(entry.json);
      mountingManager_->notifyDeleted(entry.tag);
    }
  };

  for (auto& entry : structural_) {
    if (entry.kind == Structural::Remove) {
      structuralOp(entry);
    }
  }
  for (auto& entry : structural_) {
    if (entry.kind == Structural::Delete) {
      structuralOp(entry);
    }
  }

  constexpr std::uint8_t kLayoutBits =
      kFrame | kInsets | kDisplay | kDirection | kQueued;
  std::vector<Tag> reports;
  // The nodes that wait for their emitter stay queued, compacted to the front.
  size_t held = 0;
  for (size_t i = 0; i < dirtyTags_.size(); ++i) {
    const auto tag = dirtyTags_[i];
    auto* node = find(tag);
    if (node == nullptr) {
      continue;
    }
    if (node->created) {
      // A view whose only change is its first frame has it applied by its
      // insert.
      if ((node->layoutBits & kInsertLayout) != 0 &&
          node->info->kind == Kind::View && node->parsed == nullptr &&
          (node->dirty & ~kLayoutBits) == 0) {
        node->layoutBits |= kInsertLayoutQueued;
        insertLayouts.push_back(tag);
      } else {
        updates.push_back(tag);
      }
    } else if (awaitsEmitter(*node)) {
      node->layoutBits |= kWaited;
      dirtyTags_[held++] = tag;
    } else {
      flushNode(*node, tag, batchOf(node->surfaceId), reports);
    }
  }
  dirtyTags_.resize(held);
  releaseScratch(dirtyTags_);

  size_t carried = 0;
  for (size_t i = 0; i < structural_.size(); ++i) {
    auto& entry = structural_[i];
    if (entry.kind != Structural::Insert) {
      continue;
    }
    const auto* inserted = find(entry.tag);
    const auto* parent = find(entry.parent);
    if ((inserted != nullptr && !inserted->created) ||
        (parent != nullptr && !parent->created)) {
      if (carried != i) {
        structural_[carried] = std::move(entry);
      }
      ++carried;
      continue;
    }
    structuralOp(entry);
  }
  structural_.erase(
      structural_.begin() + static_cast<std::ptrdiff_t>(carried),
      structural_.end());
  releaseScratch(structural_);
  // An insert that waits for its parent leaves the frame to an update.
  for (const auto tag : insertLayouts) {
    if (auto* node = find(tag);
        node != nullptr && (node->layoutBits & kInsertLayoutQueued) != 0) {
      node->layoutBits &= static_cast<std::uint8_t>(~kInsertLayoutQueued);
      updates.push_back(tag);
    }
  }

  for (const auto tag : updates) {
    if (auto* node = find(tag)) {
      flushNode(*node, tag, batchOf(node->surfaceId), reports);
    }
  }

  for (auto& [surfaceId, batch] : batches) {
    if (!batch.ops.empty()) {
      mountingManager_->submitBatch(surfaceId, std::move(batch));
    }
  }
  batches.clear();
  updates.clear();
  insertLayouts.clear();
  releaseScratch(updates);
  releaseScratch(insertLayouts);
  batches_ = std::move(batches);
  updates_ = std::move(updates);
  insertLayouts_ = std::move(insertLayouts);
  for (const auto tag : reports) {
    if (auto* node = find(tag)) {
      reportTextLayout(*node, tag);
    }
  }
}

// A host component is created with its event emitter, which needs the instance
// handle Loom registers; until it arrives the node, and what is inserted into
// it, wait for one flush. After that it mounts without, and gets the emitter
// with an update.
bool GpuiLoomHost::awaitsEmitter(const Node& node) const {
  return node.compat && node.compat->emitter == nullptr &&
      node.info->host != nullptr && (node.layoutBits & kWaited) == 0;
}

// The extension props of an image, a scroll view, an input or a modal: its own
// props and what the host knows of its state; for a compat component, what its
// registered extractor makes of the typed props.
std::string GpuiLoomHost::extensionJson(Node& node, Tag tag) {
  if (node.info->kind == Kind::Compat) {
    return (*node.info->hook)(node.info->name, lightView(node, tag));
  }
  auto& ext = *node.ext;
  std::string extra;
  if (node.info->kind == Kind::ScrollView && ext.hasScrollState) {
    JsonBody state;
    state.number("contentWidth", ext.content[0]);
    state.number("contentHeight", ext.content[1]);
    state.number("offsetX", ext.offset[0]);
    state.number("offsetY", ext.offset[1]);
    extra = state.body();
  }
  return closeJson(ext.body, extra);
}

// What a node sends: the whole view when its props changed, else only the
// groups layout touched.
void GpuiLoomHost::buildViewOp(Node& node, std::uint8_t dirty, MountOp& op) {
  const bool create = op.kind == MountKind::Create;
  const Size frameSize{node.frame[2], node.frame[3]};
  const bool rtl = node.direction == 2;
  const auto* deps = node.deps.get();
  if (node.parsed != nullptr) {
    op.props_changed = true;
    op.view = std::move(*node.parsed);
    node.parsed.reset();
    op.view.content_insets = {
        node.insets[0], node.insets[1], node.insets[2], node.insets[3]};
    op.view.display_none = node.displayType == 0;
    resolveLoomViewLayout(
        op.view,
        deps,
        frameSize,
        rtl,
        kPatchRadii | kPatchWidths | kPatchTransform);
  } else if (!create) {
    std::uint8_t patch = 0;
    if ((dirty & (kInsets | kDisplay)) != 0) {
      patch |= kPatchInsets;
      op.view.content_insets = {
          node.insets[0], node.insets[1], node.insets[2], node.insets[3]};
      op.view.display_none = node.displayType == 0;
    }
    if (deps != nullptr) {
      std::uint8_t mask = 0;
      if ((dirty & kFrame) != 0) {
        mask |= (deps->radiiPercent ? kPatchRadii : 0) |
            (deps->transform.operations.empty() &&
                     !deps->transformOrigin.isSet()
                 ? 0
                 : kPatchTransform);
      }
      if ((dirty & kDirection) != 0 && deps->widthsDirectional) {
        mask |= kPatchWidths;
      }
      if (mask != 0) {
        resolveLoomViewLayout(op.view, deps, frameSize, rtl, mask);
        patch |= mask;
      }
    }
    op.layout_patch = patch;
  }
}

void GpuiLoomHost::flushNode(
    Node& node,
    Tag tag,
    MountBatch& batch,
    std::vector<Tag>& reports) {
  const bool create = !node.created;
  const bool frameChanged = (node.dirty & kFrame) != 0;
  const auto dirty = node.dirty;
  node.dirty = 0;
  node.layoutBits &= kWaited;
  node.created = true;
  const auto kind = node.info->kind;

  batch.ops.emplace_back();
  auto& op = batch.ops.back();
  op.kind = create ? MountKind::Create : MountKind::Update;
  op.tag = tag;
  op.parent_tag = create ? -1 : node.parent;
  op.index = -1;
  op.component = node.info->opName;
  op.host_index = -1;
  op.frame = {node.frame[0], node.frame[1], node.frame[2], node.frame[3]};
  op.layout_changed = create || frameChanged;
  // What the extension props are made from: the node's props (parsed into
  // `ext->body`), its state, and for a component with an extractor the frame.
  const bool extChanged = create || node.parsed != nullptr ||
      (dirty & kState) != 0 ||
      (kind == Kind::Compat &&
       ((dirty & kFrame) != 0 || node.compat->props != node.compat->sentProps ||
        node.compat->state != node.compat->sentState));
  buildViewOp(node, dirty, op);

  if (node.ext) {
    if (kind == Kind::Image) {
      syncImage(node, tag);
    }
    if (extChanged) {
      auto json = extensionJson(node, tag);
      // The mounting side takes the extension props with a changed view, or
      // with this patch alone.
      if (!op.props_changed && json != node.ext->sent) {
        op.layout_patch |= 32;
      }
      op.extension_props_json = json;
      node.ext->sent = std::move(json);
    } else {
      op.extension_props_json = node.ext->sent;
    }
    if (kind == Kind::Modal) {
      reportModal(node, tag, node.ext->visible);
    }
  }

  if (kind == Kind::Paragraph) {
    if (node.flags.onTextLayout) {
      reports.push_back(tag);
    }
    if (create || (dirty & kText) != 0) {
      op.has_paragraph = true;
      if (node.text && node.text->string) {
        op.paragraph = flattenParagraphText(
            *node.text->string, node.text->attributes, node.flags.selectable);
      } else {
        op.paragraph.selectable = node.flags.selectable;
      }
      if (node.text && node.text->prepared) {
        op.paragraph.prepared = rn_gpui_retain_prepared(
            reinterpret_cast<std::uintptr_t>(node.text->prepared.get()));
        op.paragraph.prepared_width = node.text->preparedWidth;
      }
      if (!node.flags.onTextLayout) {
        node.text.reset();
      }
    } else if ((dirty & kSelectable) != 0) {
      op.layout_patch |= 16;
      op.paragraph.selectable = node.flags.selectable;
    }
  } else if (kind == Kind::TextInput) {
    if (create || (dirty & kText) != 0 || op.props_changed) {
      op.has_paragraph = true;
      if (node.text && node.text->string) {
        op.paragraph = flattenInputText(*node.text->string);
      }
      if (op.paragraph.fragments.empty()) {
        op.paragraph.fragments.push_back(node.ext->fallback);
      }
    }
  } else if (kind == Kind::Compat) {
    auto& compat = *node.compat;
    if (node.info->host != nullptr) {
      const auto& entry = *node.info->host;
      op.host_index = static_cast<std::int32_t>(entry.index);
      if (create && compat.emitter == nullptr) {
        compat.lateEmitter = true;
        op.host_props_handle = rngpui::makeHostPropsHandle(compat.props);
        rn_gpui_log(
            2,
            "loom: " + std::string(node.info->name) + " (tag " +
                std::to_string(tag) +
                ") mounts before its event target registered; it gets its "
                "emitter when it does");
      } else if (create) {
        op.host_props_handle = rngpui::makeHostPropsHandle(compat.props);
        op.host_emitter_handle = rngpui::makeHostEmitterHandle(compat.emitter);
      } else if (compat.lateEmitter && compat.emitter != nullptr) {
        compat.lateEmitter = false;
        op.host_props_handle = rngpui::makeHostPropsHandle(compat.props);
        op.host_emitter_handle = rngpui::makeHostEmitterHandle(compat.emitter);
        op.host_changed = ~uint64_t{0};
      } else if (
          compat.sentProps && compat.props &&
          compat.sentProps.get() != compat.props.get()) {
        uint64_t inlineWords[2] = {0, 0};
        std::vector<uint64_t> heapWords;
        uint64_t* words = inlineWords;
        if (entry.changeWords > 2) {
          heapWords.assign(entry.changeWords, 0);
          words = heapWords.data();
        }
        entry.changed(*compat.sentProps, *compat.props, words);
        bool any = false;
        for (uint32_t word = 0; word < entry.changeWords; ++word) {
          any = any || words[word] != 0;
        }
        if (any) {
          op.host_props_handle = rngpui::makeHostPropsHandle(compat.props);
          op.host_changed = words[0];
          for (uint32_t word = 1; word < entry.changeWords; ++word) {
            op.host_changed_more.push_back(words[word]);
          }
        }
      }
    }
    compat.sentProps = compat.props;
    compat.sentState = compat.state;
  }
  if (!create && frameChanged && !gpuiExtensionHooks().mountObservers.empty()) {
    mountingManager_->notifyFrameChanged(node.surfaceId, lightView(node, tag));
  }
}

// Fabric's paragraph reports its wrapped lines after each layout.
void GpuiLoomHost::reportTextLayout(Node& node, Tag tag) {
  if (!node.text || !node.text->string) {
    return;
  }
  auto& text = *node.text;
  const Size size{node.frame[2], node.frame[3]};
  if (text.reportedString == text.string && text.reportedSize == size) {
    return;
  }
  text.reportedString = text.string;
  text.reportedSize = size;
  folly::dynamic lines = folly::dynamic::array();
  for (const auto& line : text_.layoutManager()->measureLines(
           AttributedStringBox{*text.string}, text.attributes, size)) {
    lines.push_back(folly::dynamic::object("text", line.text)(
        "x", line.frame.origin.x)("y", line.frame.origin.y)(
        "width", line.frame.size.width)("height", line.frame.size.height)(
        "descender", line.descender)("capHeight", line.capHeight)(
        "ascender", line.ascender)("xHeight", line.xHeight));
  }
  dispatchTargetEvent(
      tag, "topTextLayout", folly::dynamic::object("lines", std::move(lines)));
}

void GpuiLoomHost::scheduleFlush() {
  if (flushScheduled_) {
    return;
  }
  flushScheduled_ = true;
  postToLoomUI([weak = weak_from_this()] {
    if (auto self = weak.lock()) {
      std::lock_guard<std::recursive_mutex> lock(self->mutex_);
      if (self->flushScheduled_) {
        self->flushLocked();
      }
    }
  });
}

void GpuiLoomHost::runOnUIThread(std::function<void()> task) {
  if (loomUIIsMountThread()) {
    MountThread::shared().post(std::move(task));
  } else {
    task();
  }
}

void GpuiLoomHost::failSurface(SurfaceId surfaceId, const std::string& reason) {
  LOG(ERROR) << "Loom stopped surface " << surfaceId << ": " << reason;
}

void GpuiLoomHost::updateViewProps(Tag tag, const folly::dynamic& props) {
  LoomBinding::recordNativeProps(tag, props);
  mountingManager_->synchronouslyUpdateViewOnUIThread(tag, props);
}

std::optional<GpuiMountingManager::AnimatedGeometry>
GpuiLoomHost::animatedGeometry(Tag tag) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  const auto* node = find(tag);
  if (node == nullptr) {
    return std::nullopt;
  }
  GpuiMountingManager::AnimatedGeometry geometry{
      {node->frame[2], node->frame[3]}, {}};
  if (node->deps) {
    geometry.transformOrigin = node->deps->transformOrigin;
  }
  return geometry;
}

void GpuiLoomHost::registerEventTarget(
    SurfaceId surfaceId,
    Tag tag,
    InstanceHandle::Shared instanceHandle) {
  if (!instanceHandle) {
    return;
  }
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (!ensureScheduler()) {
    return;
  }
  std::shared_ptr<LoomEventManager> manager;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    instanceHandles_[tag] = {surfaceId, instanceHandle};
    manager = eventManager_;
  }
  manager->registerTarget(surfaceId, tag, instanceHandle);
  std::optional<EarlyLayout> early;
  std::vector<std::pair<std::string, folly::dynamic>> pending;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    if (const auto found = earlyLayouts_.find(tag);
        found != earlyLayouts_.end()) {
      early = found->second;
      earlyLayouts_.erase(found);
    }
    if (const auto found = pendingEvents_.find(tag);
        found != pendingEvents_.end()) {
      pending = std::move(found->second);
      pendingEvents_.erase(found);
    }
  }
  for (auto& [type, payload] : pending) {
    manager->dispatch(
        surfaceId,
        tag,
        type,
        std::move(payload),
        RawEvent::Category::Unspecified,
        false,
        HighResTimeStamp::now());
  }
  if (early) {
    manager->dispatch(
        surfaceId,
        tag,
        "topLayout",
        folly::dynamic::object(
            "layout",
            folly::dynamic::object("x", early->x)("y", early->y)(
                "width", early->width)("height", early->height)),
        RawEvent::Category::Unspecified,
        false,
        HighResTimeStamp::now());
  }
  if (auto* node = find(tag); node != nullptr && node->compat) {
    node->compat->emitter = makeEmitter(*node, tag);
    markDirty(*node, tag, 0);
    scheduleFlush();
  }
}

// A node's instance handle wraps a weak JavaScript object, which JSI only lets
// go of on the JavaScript thread. The emitters the Rust store holds can outlive
// the node, so they are disabled (which drops their event target), and the
// references this host holds are released on the JavaScript thread.
void GpuiLoomHost::unregisterEventTarget(SurfaceId surfaceId, Tag tag) {
  unregisterEventTargets(surfaceId, {tag});
}

void GpuiLoomHost::unregisterEventTargets(
    SurfaceId surfaceId,
    const std::vector<Tag>& tags) {
  struct Released {
    Tag tag;
    InstanceHandle::Shared handle;
    ShadowNodeFamily::Shared family;
    std::shared_ptr<facebook::react::EventTarget> wheelTarget;
  };
  std::vector<Released> released;
  released.reserve(tags.size());
  std::shared_ptr<LoomEventManager> manager;
  {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    std::lock_guard<std::mutex> events(eventMutex_);
    manager = eventManager_;
    for (const auto tag : tags) {
      pendingEvents_.erase(tag);
      Released target{tag, nullptr, nullptr, nullptr};
      if (const auto found = instanceHandles_.find(tag);
          found != instanceHandles_.end()) {
        target.handle = std::move(found->second.handle);
        instanceHandles_.erase(found);
      }
      if (const auto found = wheelTargets_.find(tag);
          found != wheelTargets_.end()) {
        target.wheelTarget = std::move(found->second);
        wheelTargets_.erase(found);
      }
      if (const auto found = families_.find(tag); found != families_.end()) {
        target.family = std::move(found->second);
        families_.erase(found);
        target.family->getEventEmitter()->setEnabled(false);
      }
      released.push_back(std::move(target));
    }
  }
  jsAccess_([surfaceId,
             manager = std::move(manager),
             released = std::move(released)] {
    if (manager) {
      for (const auto& target : released) {
        manager->unregisterTarget(surfaceId, target.tag);
      }
    }
  });
}

void GpuiLoomHost::dispatchEvent(
    SurfaceId surfaceId,
    Tag tag,
    const std::string& eventName,
    folly::dynamic payload,
    RawEvent::Category category,
    bool unique) {
  std::shared_ptr<LoomEventManager> manager;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    manager = eventManager_;
  }
  if (manager) {
    manager->dispatch(
        surfaceId,
        tag,
        eventName,
        std::move(payload),
        category,
        unique,
        HighResTimeStamp::now());
  }
}

// An event from the GPUI side goes the way Loom's own events do, to the target
// registered for the tag.
void GpuiLoomHost::dispatchTargetEvent(
    Tag tag,
    const std::string& type,
    folly::dynamic&& payload) {
  std::shared_ptr<LoomEventManager> manager;
  SurfaceId surfaceId;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    const auto found = instanceHandles_.find(tag);
    if (!eventManager_) {
      return;
    }
    if (found == instanceHandles_.end()) {
      auto& queue = pendingEvents_[tag];
      if (queue.size() < 16) {
        queue.emplace_back(type, std::move(payload));
      }
      return;
    }
    surfaceId = found->second.surfaceId;
    manager = eventManager_;
  }
  manager->dispatch(
      surfaceId,
      tag,
      type,
      std::move(payload),
      RawEvent::Category::Unspecified,
      false,
      HighResTimeStamp::now());
}

// An event from the GPUI side goes the way Loom's own events do, to the target
// registered for the tag.
void GpuiLoomHost::dispatchNativeEvent(
    Tag tag,
    const std::string& type,
    folly::dynamic&& payload) {
  std::shared_ptr<LoomEventManager> manager;
  SurfaceId surfaceId;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    const auto found = instanceHandles_.find(tag);
    if (found == instanceHandles_.end() || !eventManager_) {
      // The node mounts before Loom registers its target; the layout it was
      // given at mount is what React is waiting for.
      if (type == "topLayout" && payload.isObject()) {
        if (const auto* layout = payload.get_ptr("layout");
            layout != nullptr && layout->isObject()) {
          const auto number = [&](const char* key) {
            const auto* value = layout->get_ptr(key);
            return value != nullptr && value->isNumber()
                ? static_cast<float>(value->asDouble())
                : 0.f;
          };
          earlyLayouts_[tag] = {
              number("x"), number("y"), number("width"), number("height")};
        }
      }
      return;
    }
    surfaceId = found->second.surfaceId;
    manager = eventManager_;
  }
  // Only the latest scroll position matters: a queued scroll event that JS has
  // not handled yet is replaced rather than piled up behind.
  manager->dispatch(
      surfaceId,
      tag,
      EventEmitter::normalizeEventType(type),
      std::move(payload),
      RawEvent::Category::Unspecified,
      type == "topScroll",
      HighResTimeStamp::now());
}

void GpuiLoomHost::dispatchNativeWheel(
    Tag tag,
    std::uint64_t id,
    folly::dynamic&& payload) {
  std::shared_ptr<facebook::react::EventTarget> target;
  EventDispatcher::Weak dispatcher;
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    const auto entry = instanceHandles_.find(tag);
    if (entry == instanceHandles_.end()) {
      rn_gpui_on_wheel_done(id, false);
      return;
    }
    auto& wheel = wheelTargets_[tag];
    if (!wheel) {
      wheel = std::make_shared<facebook::react::EventTarget>(
          entry->second.handle, entry->second.surfaceId);
      wheel->setEnabled(true);
    }
    target = wheel;
    dispatcher = eventDispatcher_;
  }
  GpuiMountingManager::dispatchWheelTo(
      EventEmitter(std::move(target), std::move(dispatcher)),
      id,
      std::move(payload));
}

void GpuiLoomHost::updateComponentState(
    SurfaceId /*surfaceId*/,
    Tag tag,
    const std::shared_ptr<const State>& state) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (viewless_.count(tag) != 0) {
    return;
  }
  if (auto* node = find(tag)) {
    mountingManager_->setComponentState(
        tag, node->info->name, node->info->handle, state);
    if (node->compat) {
      node->compat->state = state;
      markDirty(*node, tag, kState);
      scheduleFlush();
    }
  } else {
    pendingEffects_[tag].state = state;
  }
}

void GpuiLoomHost::updateTextState(const LoomTextStateUpdate& update) {
  if (update.attributedString == nullptr) {
    return;
  }
  if (update.kind != LoomTextStateKind::Text &&
      update.kind != LoomTextStateKind::Paragraph &&
      update.kind != LoomTextStateKind::SelectableParagraph &&
      update.kind != LoomTextStateKind::TextInput) {
    return;
  }
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  if (viewless_.count(update.tag) != 0) {
    return;
  }
  auto text = std::make_unique<TextData>();
  text->string = update.attributedString;
  text->attributes = update.paragraphAttributes;
  if (update.prepared.valid && update.prepared.preparedLayout) {
    text->prepared = update.prepared.preparedLayout;
    text->preparedWidth = update.prepared.size.width;
  }
  auto* node = find(update.tag);
  if (node == nullptr) {
    pendingEffects_[update.tag].text = std::move(text);
    return;
  }
  const auto kind = node->info->kind;
  if (kind != Kind::Paragraph && kind != Kind::TextInput) {
    return;
  }
  if (node->text) {
    text->reportedString = std::move(node->text->reportedString);
    text->reportedSize = node->text->reportedSize;
  }
  node->text = std::move(text);
  markDirty(*node, update.tag, kText);
  scheduleFlush();
}

void GpuiLoomHost::updateScrollContentBounds(
    SurfaceId /*surfaceId*/,
    Tag tag,
    const folly::dynamic& props,
    const Rect& bounds) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  std::array<float, 2> offset{};
  std::optional<std::pair<float, float>> live;
  {
    std::lock_guard<std::mutex> scroll(scrollMutex_);
    if (const auto found = scrollOffsets_.find(tag);
        found != scrollOffsets_.end()) {
      live = found->second;
    }
  }
  if (live) {
    offset = {live->first, live->second};
  } else if (props.isObject() && props.count("contentOffset") != 0) {
    const auto& requested = props["contentOffset"];
    if (requested.isObject()) {
      const auto* x = requested.get_ptr("x");
      const auto* y = requested.get_ptr("y");
      if (x != nullptr && x->isNumber()) {
        offset[0] = static_cast<float>(x->asDouble());
      }
      if (y != nullptr && y->isNumber()) {
        offset[1] = static_cast<float>(y->asDouble());
      }
    }
  }
  const auto content =
      ScrollViewState{{offset[0], offset[1]}, bounds, 0}.getContentSize();
  const std::array<float, 2> size{content.width, content.height};
  if (auto* node = find(tag)) {
    if (node->ext) {
      node->ext->hasScrollState = true;
      node->ext->offset = offset;
      node->ext->content = size;
      markDirty(*node, tag, kState);
      scheduleFlush();
    }
  } else {
    auto& pending = pendingEffects_[tag];
    pending.hasScrollState = true;
    pending.offset = offset;
    pending.content = size;
  }
}

void GpuiLoomHost::dispatchCommand(
    SurfaceId /*surfaceId*/,
    Tag tag,
    const std::string& commandName,
    const folly::dynamic& args) {
  std::string_view name;
  ComponentHandle handle{};
  {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    const auto* node = find(tag);
    if (node == nullptr) {
      return;
    }
    name = node->info->name;
    handle = node->info->handle;
  }
  mountingManager_->dispatchCommand(tag, name, handle, commandName, args);
}

std::pair<float, float> GpuiLoomHost::getScrollOffset(
    SurfaceId /*surfaceId*/,
    Tag tag) {
  std::lock_guard<std::mutex> scroll(scrollMutex_);
  const auto found = scrollOffsets_.find(tag);
  return found == scrollOffsets_.end() ? std::pair<float, float>{0, 0}
                                       : found->second;
}

std::optional<std::pair<float, float>> GpuiLoomHost::getViewLocationInSurface(
    SurfaceId /*surfaceId*/,
    Tag tag) {
  std::lock_guard<std::mutex> lock(scrollMutex_);
  const auto placed = [&](Tag at) -> const Node* {
    const auto found = nodes_.find(at);
    return found != nodes_.end() && found->second.laidOut ? &found->second
                                                          : nullptr;
  };
  const auto* node = placed(tag);
  if (node == nullptr) {
    return std::nullopt;
  }
  float x = 0;
  float y = 0;
  // The frames are relative to the parent; a scrolled ancestor moves what it
  // holds by its offset.
  for (int depth = 0; node != nullptr && depth < 4096; ++depth) {
    x += node->frame[0];
    y += node->frame[1];
    const auto parent = node->parent;
    if (const auto offset = scrollOffsets_.find(parent);
        offset != scrollOffsets_.end()) {
      x -= offset->second.first;
      y -= offset->second.second;
    }
    node = placed(parent);
  }
  return std::pair<float, float>{x, y};
}

void GpuiLoomHost::setScrollOffset(Tag tag, float x, float y) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  {
    std::lock_guard<std::mutex> scroll(scrollMutex_);
    scrollOffsets_[tag] = {x, y};
  }
  if (auto* node = find(tag);
      node != nullptr && node->ext && node->ext->hasScrollState) {
    node->ext->offset = {x, y};
    markDirty(*node, tag, kState);
    scheduleFlush();
  }
}

void GpuiLoomHost::setPointScaleFactor(float scale) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  pointScaleFactor_ = scale;
  text_.setPointScaleFactor(scale);
  LoomBinding::setPointScaleFactor(scale);
}

bool GpuiLoomHost::writeMeasuredSize(
    Tag tag,
    std::optional<float> width,
    std::optional<float> height,
    std::optional<float> minWidth,
    folly::dynamic layout) {
  auto* host = active_.load(std::memory_order_acquire);
  if (host == nullptr) {
    return false;
  }
  const auto runtime = loom::Runtime::from(*host->contextContainer_);
  if (!runtime) {
    return false;
  }
  const loom::MeasuredSize size{width, height, minWidth};
  bool written = false;
  runtime->forEachSurface([&](SurfaceId surfaceId) {
    if (written || !runtime->setMeasuredSize(surfaceId, tag, size)) {
      return;
    }
    written = true;
    if (!layout.empty()) {
      runtime->updateNativeProps(surfaceId, tag, std::move(layout));
    }
  });
  return written;
}

void AnimationFrameSource::resume() {
  running_.store(true, std::memory_order_release);
  requestFrames("animation-backend", true);
  reportPendingWork("animation-backend", 1);
}

void AnimationFrameSource::pause() {
  running_.store(false, std::memory_order_release);
  requestFrames("animation-backend", false);
  reportPendingWork("animation-backend", 0);
}

void AnimationFrameSource::tick() const {
  if (running_.load(std::memory_order_acquire)) {
    onAnimationFrame(now());
  }
}

void GpuiLoomHost::installSizeHints() {
  const auto runtime = loom::Runtime::from(*contextContainer_);
  if (!runtime) {
    return;
  }
  sizeHints_ = runtime->setInitialMeasuredSize(
      "DesktopNativeRoot",
      [](const folly::dynamic& props) -> std::optional<loom::MeasuredSize> {
        const auto read = [&props](const char* key) -> std::optional<float> {
          const auto it = props.find(key);
          if (it == props.items().end() || !it->second.isNumber() ||
              it->second.asDouble() < 0) {
            return std::nullopt;
          }
          return static_cast<float>(it->second.asDouble());
        };
        loom::MeasuredSize size;
        size.height = read("hintHeight");
        if (const auto width = read("hintWidth")) {
          if (const auto minWidth = read("hintMinWidth")) {
            size.width = width;
            size.minWidth = minWidth;
          }
        }
        if (!size.height && !size.width) {
          return std::nullopt;
        }
        return size;
      });
}

std::optional<Size> GpuiLoomHost::surfaceContentSize(SurfaceId surfaceId) {
  const auto runtime = loom::Runtime::from(*contextContainer_);
  if (!runtime) {
    return std::nullopt;
  }
  return runtime->latest().surfaceSize(surfaceId);
}

void GpuiLoomHost::begin() {
  std::unique_lock<std::shared_mutex> alive(lifetimeMutex_);
  alive_ = true;
}

// Called with the JavaScript thread stopped and its runtime still alive: the
// Rust store holds typed emitters until it drops the old tree, which is after
// the runtime is gone, so they let go of their event targets here.
void GpuiLoomHost::reset() {
  {
    std::unique_lock<std::shared_mutex> alive(lifetimeMutex_);
    alive_ = false;
  }
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  for (const auto& [tag, family] : families_) {
    family->getEventEmitter()->setEnabled(false);
  }
  for (const auto& [tag, observation] : imageObservations_) {
    observation.coordinator->removeObserver(observation.observer);
  }
  imageObservations_.clear();
  for (const auto& [tag, node] : nodes_) {
    mountingManager_->clearComponentState(tag);
  }
  registry_ = nullptr;
  components_.clear();
  {
    std::lock_guard<std::mutex> events(eventMutex_);
    pendingEvents_.clear();
    eventManager_ = nullptr;
    eventDispatcher_.reset();
    instanceHandles_.clear();
    wheelTargets_.clear();
    earlyLayouts_.clear();
  }
  decltype(nodes_) nodes;
  {
    std::lock_guard<std::mutex> scroll(scrollMutex_);
    nodes.swap(nodes_);
    scrollOffsets_.clear();
  }
  nodes.clear();
  viewless_.clear();
  dirtyTags_ = {};
  structural_ = {};
  batches_ = {};
  updates_ = {};
  insertLayouts_ = {};
  families_.clear();
  pendingEffects_.clear();
  flushScheduled_ = false;
}

} // namespace rngpui

#endif // LOOM_RENDERER
