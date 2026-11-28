// The Loom renderer's host: it turns Loom's mount batches and per-node effects
// straight into the mount ops the Rust node store applies, and answers Loom's
// live queries. Compiled only with LOOM_RENDERER.
//
// A view or a paragraph is a node of a few words: Loom's raw props become the
// flat view props when the node is created or updated, and are not kept. Any
// other component keeps React Native's typed props, state and event emitter,
// because the code that reads them (host components, the per-component prop
// extractors) is written against those types.
#pragma once

#if LOOM_RENDERER

#include "GpuiMountingManager.h"

#include <react/loom/Loom.h>
#include <react/renderer/animationbackend/AnimationChoreographer.h>
#include <react/renderer/componentregistry/ComponentDescriptorRegistry.h>
#include <react/renderer/imagemanager/ImageManager.h>
#include <react/renderer/imagemanager/ImageRequest.h>
#include <react/renderer/loom/binding/LoomEventManager.h>
#include <react/renderer/loom/core/LoomRenderer.h>
#include <react/renderer/loom/host/LoomHost.h>
#include <react/renderer/loom/text/LoomTextLayoutManagerServices.h>
#include <react/renderer/mounting/ShadowView.h>
#include <react/renderer/scheduler/Scheduler.h>
#include "LoomComponentProps.h"
#include "LoomViewProps.h"

#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace rngpui {

using facebook::react::LoomHost;

/// The frame source of React Native's shared animation backend: it asks core
/// for frames while an animation runs, and delivers one animation frame with
/// each of them.
class AnimationFrameSource final
    : public facebook::react::AnimationChoreographer {
 public:
  void resume() override;
  void pause() override;
  /// Called once per display frame on the main thread.
  void tick() const;

 private:
  std::atomic<bool> running_{false};
};

/// Text measurement over core's TextLayoutManager, with the text scale the
/// shadow tree would have applied.
class GpuiLoomTextServices final
    : public facebook::react::LoomTextLayoutManagerServices {
 public:
  GpuiLoomTextServices(
      std::shared_ptr<const facebook::react::ContextContainer> contextContainer,
      std::shared_ptr<const facebook::react::TextLayoutManager> layoutManager);

  facebook::react::TextAttributes parseTextAttributes(
      facebook::react::SurfaceId surfaceId,
      const std::string& componentName,
      const folly::dynamic& props,
      const facebook::react::TextAttributes& inherited,
      facebook::react::ParagraphAttributes& outParagraphAttributes) override;

  /// Shapes on the calling thread and keeps the layout, which the paragraph's
  /// mount op then carries to the view.
  facebook::react::LoomTextMeasurement prepareText(
      facebook::react::SurfaceId surfaceId,
      const facebook::react::AttributedString& attributedString,
      const facebook::react::ParagraphAttributes& paragraphAttributes,
      const facebook::react::Size& minimumSize,
      const facebook::react::Size& maximumSize) override;
  facebook::react::LoomTextMeasurement prepareTextForMount(
      facebook::react::SurfaceId surfaceId,
      const facebook::react::AttributedString& attributedString,
      const facebook::react::ParagraphAttributes& paragraphAttributes,
      const facebook::react::Size& minimumSize,
      const facebook::react::Size& maximumSize) override;

  const std::shared_ptr<const facebook::react::TextLayoutManager>&
  layoutManager() const {
    return layoutManager_;
  }

 private:
  std::shared_ptr<const facebook::react::TextLayoutManager> layoutManager_;
  std::shared_ptr<const facebook::react::ContextContainer> contextContainer_;
};

class GpuiLoomHost final : public LoomHost,
                           public std::enable_shared_from_this<GpuiLoomHost> {
 public:
  /// Reads the scheduler of the running React instance, or does nothing when
  /// there is none (a reload is in progress).
  using SchedulerAccess =
      std::function<void(std::function<void(facebook::react::Scheduler&)>&&)>;
  /// Runs a function on the JavaScript thread (the calling one when
  /// JavaScript runs on the UI thread), or drops it when no instance is up.
  using JsAccess = std::function<void(std::function<void()>&&)>;

  ~GpuiLoomHost() override;
  GpuiLoomHost(
      std::shared_ptr<GpuiMountingManager> mountingManager,
      std::shared_ptr<const facebook::react::ContextContainer> contextContainer,
      SchedulerAccess schedulerAccess,
      JsAccess jsAccess);

  facebook::react::LoomPlatformTraits traits() const override;
  std::function<void(std::function<void()>)> uiExecutor() override;
  void applyBatch(
      facebook::react::SurfaceId surfaceId,
      facebook::react::LoomMountBatch batch) override;
  void failSurface(
      facebook::react::SurfaceId surfaceId,
      const std::string& reason) override;
  void updateViewProps(facebook::react::Tag tag, const folly::dynamic& props)
      override;
  void registerEventTarget(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag,
      facebook::react::InstanceHandle::Shared instanceHandle) override;
  void unregisterEventTarget(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag) override;
  void unregisterEventTargets(
      facebook::react::SurfaceId surfaceId,
      const std::vector<facebook::react::Tag>& tags) override;
  void dispatchEvent(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag,
      const std::string& eventName,
      folly::dynamic payload,
      facebook::react::RawEvent::Category category,
      bool unique) override;
  /// Sets the size the runtime measured for a native root or slot as the
  /// node's Loom measured size, with `layout` (one-shot layout props) beside
  /// it. False when no running surface has the node.
  static bool writeMeasuredSize(
      facebook::react::Tag tag,
      std::optional<float> width,
      std::optional<float> height,
      std::optional<float> minWidth,
      folly::dynamic layout);
  /// Gives a new native root its remembered size (its hint props) before its
  /// first layout. Needs the host registered in the context container.
  void installSizeHints();
  const std::shared_ptr<AnimationFrameSource>& animationFrameSource() const {
    return animationFrameSource_;
  }
  void updateComponentState(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag,
      const std::shared_ptr<const facebook::react::State>& state) override;
  void updateTextState(
      const facebook::react::LoomTextStateUpdate& update) override;
  void updateScrollContentBounds(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag,
      const folly::dynamic& props,
      const facebook::react::Rect& bounds) override;
  void dispatchCommand(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag,
      const std::string& commandName,
      const folly::dynamic& args) override;
  std::pair<float, float> getScrollOffset(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag) override;
  std::optional<std::pair<float, float>> getViewLocationInSurface(
      facebook::react::SurfaceId surfaceId,
      facebook::react::Tag tag) override;
  facebook::react::LoomTextServices* textServices() override {
    return &text_;
  }

  /// Points the mounting manager's events, wheel events and animated
  /// geometry at this host's nodes. Call once, after the host is owned by a
  /// `shared_ptr`.
  void connect();

  /// Delivers an event to the target registered for `tag`.
  void dispatchTargetEvent(
      facebook::react::Tag tag,
      const std::string& type,
      folly::dynamic&& payload);

  /// Runs `task` on Loom's UI thread: the mount thread when JavaScript runs on
  /// its own thread (posted), else the calling GPUI main thread (now).
  static void runOnUIThread(std::function<void()> task);

  /// A scroll position GPUI reports, kept for `getScrollOffset`.
  void setScrollOffset(facebook::react::Tag tag, float x, float y);
  void setPointScaleFactor(float scale);
  /// The size a surface's root was laid out at.
  std::optional<facebook::react::Size> surfaceContentSize(
      facebook::react::SurfaceId surfaceId);
  /// A React instance came up: Loom's callbacks may run again.
  void begin();
  /// Forgets every node: the React instance is going. Waits for a callback of
  /// the old instance that is running, and drops the ones not yet run, which
  /// would otherwise reach into a renderer that is being destroyed.
  void reset();
  /// Commits Loom is still computing, and tasks posted to the UI thread that
  /// have not run: work that will mount without anything having been queued.
  static std::uint64_t pending();

 private:
  enum class Kind : std::uint8_t {
    View,
    Paragraph,
    Image,
    ScrollView,
    TextInput,
    Modal,
    /// A component whose code reads React Native's typed props (host
    /// components, the per-component prop extractors, third-party libraries).
    Compat,
  };

  /// What a component name resolves to, once.
  struct ComponentInfo {
    const facebook::react::ComponentDescriptor* descriptor{nullptr};
    facebook::react::ComponentName name{nullptr};
    /// `name` as the mount ops carry it.
    rust::Str opName;
    facebook::react::ComponentHandle handle{0};
    facebook::react::ShadowNodeTraits traits;
    Kind kind{Kind::Compat};
    const rngpui::HostComponentEntry* host{nullptr};
    const rngpui::extension::ComponentPropsFn* hook{nullptr};
  };

  enum Dirty : std::uint8_t {
    kFrame = 1,
    kInsets = 2,
    kDisplay = 4,
    kDirection = 8,
    kText = 16,
    kSelectable = 32,
    kState = 64,
    kQueued = 128,
  };

  /// The text a paragraph or an input was last given, held until the next
  /// flush (and for good by a paragraph that reports its lines and by an
  /// input).
  struct TextData {
    std::shared_ptr<const facebook::react::AttributedString> string;
    facebook::react::ParagraphAttributes attributes;
    std::shared_ptr<const facebook::react::AttributedString> reportedString;
    facebook::react::Size reportedSize{};
    /// The layout shaped for this text, and the content width it fits.
    std::shared_ptr<void> prepared;
    float preparedWidth{0};
  };

  /// What an image, a scroll view, an input or a modal needs beyond its view
  /// props.
  struct Ext {
    /// The component's props as JSON, between the braces.
    std::string body;
    /// What the Rust store last received.
    std::string sent;
    std::vector<facebook::react::ImageSource> sources;
    float blurRadius{0};
    std::optional<facebook::react::ImageSource> requested;
    facebook::react::ImageRequestParams requestedParams{};
    std::unique_ptr<facebook::react::ImageRequest> request;
    bool hasScrollState{false};
    std::array<float, 2> offset{};
    std::array<float, 2> content{};
    TextFragmentFlat fallback;
    bool visible{true};
    bool shown{false};
  };

  /// The typed props, state and emitter of a compat component, and the ones
  /// the Rust store last received.
  struct Compat {
    facebook::react::Props::Shared props;
    facebook::react::Props::Shared sentProps;
    facebook::react::State::Shared state;
    facebook::react::State::Shared sentState;
    facebook::react::EventEmitter::Shared emitter;
    /// Mounted without its emitter: the component gets it with a later update.
    bool lateEmitter{false};
  };

  struct Node {
    facebook::react::SurfaceId surfaceId{0};
    facebook::react::Tag parent{-1};
    const ComponentInfo* info{nullptr};
    std::array<float, 4> frame{};
    std::array<float, 4> insets{};
    std::uint8_t displayType{1};
    std::uint8_t direction{0};
    std::uint8_t dirty{0};
    bool created{false};
    /// `kInsertLayout`: the node's first frame arrived with its insert, after
    /// its create. `kInsertLayoutQueued`: this flush applies it with the
    /// insert. `kWaited`: a host component's flush waited for its emitter.
    std::uint8_t layoutBits{0};
    /// The node has a frame. Written with `scrollMutex_` held too.
    bool laidOut{false};
    LoomViewFlags flags;
    /// The props of the node, parsed and waiting for the flush.
    std::unique_ptr<ViewPropsFlat> parsed;
    std::unique_ptr<LoomViewDeps> deps;
    std::unique_ptr<TextData> text;
    std::unique_ptr<Ext> ext;
    std::unique_ptr<Compat> compat;
  };

  /// A change to the tree, kept in the order Loom made it.
  struct Structural {
    enum Op : std::uint8_t { Remove, Insert, Delete } kind;
    facebook::react::SurfaceId surfaceId;
    facebook::react::Tag tag;
    facebook::react::Tag parent;
    std::int32_t index;
    const ComponentInfo* info;
    /// The extension props the node last had, which a portal's insertion and
    /// removal are decided by.
    std::string json;
  };

  static constexpr std::uint8_t kInsertLayout = 1;
  static constexpr std::uint8_t kInsertLayoutQueued = 2;
  static constexpr std::uint8_t kWaited = 4;

  struct PendingEffects {
    facebook::react::State::Shared state;
    std::unique_ptr<TextData> text;
    bool hasScrollState{false};
    std::array<float, 2> offset{};
    std::array<float, 2> content{};
  };

  struct EarlyLayout {
    float x, y, width, height;
  };

  bool ensureScheduler();
  Node* find(facebook::react::Tag tag);
  const ComponentInfo* componentInfo(const std::string& name);
  void markDirty(Node& node, facebook::react::Tag tag, std::uint8_t bits);
  void onCreate(
      const facebook::react::PropsParserContext& context,
      const facebook::react::DirectCreateOperation& operation);
  void onUpdateProps(
      const facebook::react::PropsParserContext& context,
      const facebook::react::DirectUpdatePropsOperation& operation);
  void parseView(
      const facebook::react::PropsParserContext& context,
      Node& node,
      const folly::dynamic& props);
  void retire(facebook::react::Tag tag);
  facebook::react::EventEmitter::Shared makeEmitter(
      const Node& node,
      facebook::react::Tag tag);
  void syncImage(Node& node, facebook::react::Tag tag);
  void reportModal(Node& node, facebook::react::Tag tag, bool visible);
  std::string extensionJson(Node& node, facebook::react::Tag tag);
  facebook::react::ShadowView lightView(
      const Node& node,
      facebook::react::Tag tag) const;
  void flushLocked();
  bool awaitsEmitter(const Node& node) const;
  void flushNode(
      Node& node,
      facebook::react::Tag tag,
      MountBatch& batch,
      std::vector<facebook::react::Tag>& reports);
  void buildViewOp(Node& node, std::uint8_t dirty, MountOp& op);
  void reportTextLayout(Node& node, facebook::react::Tag tag);
  void scheduleFlush();
  void drop(facebook::react::Tag tag);
  void dispatchNativeEvent(
      facebook::react::Tag tag,
      const std::string& type,
      folly::dynamic&& payload);
  void dispatchNativeWheel(
      facebook::react::Tag tag,
      std::uint64_t id,
      folly::dynamic&& payload);
  std::optional<GpuiMountingManager::AnimatedGeometry> animatedGeometry(
      facebook::react::Tag tag);

  std::shared_ptr<GpuiMountingManager> mountingManager_;
  std::shared_ptr<const facebook::react::ContextContainer> contextContainer_;
  SchedulerAccess schedulerAccess_;
  JsAccess jsAccess_;
  GpuiLoomTextServices text_;
  std::shared_ptr<facebook::react::ImageManager> imageManager_;

  std::recursive_mutex mutex_;
  std::shared_mutex lifetimeMutex_;
  bool alive_{true};
  std::shared_ptr<const facebook::react::ComponentDescriptorRegistry> registry_;
  std::unordered_map<std::string, ComponentInfo> components_;
  /// Changed with `scrollMutex_` held too, so JavaScript-thread reads of a
  /// node's place (`getViewLocationInSurface`) can take that lock alone.
  facebook::react::TagMap<Node> nodes_;
  facebook::react::TagHashSet viewless_;
  std::vector<facebook::react::Tag> dirtyTags_;
  std::vector<Structural> structural_;
  /// Scratch of `flushLocked`, kept between flushes.
  std::vector<std::pair<facebook::react::SurfaceId, MountBatch>> batches_;
  std::vector<facebook::react::Tag> updates_;
  std::vector<facebook::react::Tag> insertLayouts_;
  facebook::react::TagMap<PendingEffects> pendingEffects_;
  /// Keeps the event emitter of a node that needs a typed one alive; the
  /// emitter does not own its family.
  facebook::react::TagMap<facebook::react::ShadowNodeFamily::Shared> families_;
  struct ImageObservation {
    std::shared_ptr<const facebook::react::ImageResponseObserverCoordinator>
        coordinator;
    std::shared_ptr<const facebook::react::ImageResponseObserver> observer;
  };
  facebook::react::TagMap<ImageObservation> imageObservations_;
  /// Guards `eventManager_`, `eventDispatcher_`, `instanceHandles_` and
  /// `wheelTargets_`, which
  /// events from the GPUI main thread read without `mutex_`.
  mutable std::mutex eventMutex_;
  std::shared_ptr<facebook::react::LoomEventManager> eventManager_;
  facebook::react::EventDispatcher::Weak eventDispatcher_;
  struct EventTarget {
    facebook::react::SurfaceId surfaceId;
    facebook::react::InstanceHandle::Shared handle;
  };
  facebook::react::TagMap<EventTarget> instanceHandles_;
  /// What a node's wheel events are delivered through, made on the first one.
  facebook::react::TagMap<std::shared_ptr<facebook::react::EventTarget>>
      wheelTargets_;
  /// Events of a node whose target is not registered yet (an image's load
  /// events, a modal's show), delivered when it is.
  facebook::react::TagMap<std::vector<std::pair<std::string, folly::dynamic>>>
      pendingEvents_;
  /// The layout event of a node that mounted before its target registered.
  facebook::react::TagMap<EarlyLayout> earlyLayouts_;
  /// Guards `scrollOffsets_`, and is held with `mutex_` where `nodes_` changes
  /// and where a node's frame, parent and `laidOut` are written.
  mutable std::mutex scrollMutex_;
  facebook::react::TagMap<std::pair<float, float>> scrollOffsets_;
  bool flushScheduled_{false};
  static inline std::atomic<std::uint64_t> pendingUiTasks_{0};
  static inline std::atomic<GpuiLoomHost*> active_{nullptr};
  float pointScaleFactor_{1.f};
  facebook::react::loom::Subscription sizeHints_;
  std::shared_ptr<AnimationFrameSource> animationFrameSource_ =
      std::make_shared<AnimationFrameSource>();
};

} // namespace rngpui

#endif // LOOM_RENDERER
