#pragma once

#include <folly/dynamic.h>
#include <react/io/IImageLoader.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/components/modal/ModalHostViewState.h>
#include <react/renderer/components/nativeroot/NativeRoot.h>
#include <react/renderer/components/nativeslot/NativeSlot.h>
#include <react/renderer/components/scrollview/ScrollViewState.h>
#include <react/renderer/components/view/primitives.h>
#include <react/renderer/core/ConcreteState.h>
#include <react/renderer/graphics/Size.h>
#include <react/renderer/imagemanager/ImageResponseObserverCoordinator.h>
#include <react/renderer/uimanager/IMountingManager.h>
#include "GpuiHostComponentsCpp.h"
#include "GpuiImageLoad.h"
#include "GpuiImageLoader.h"
#include "GpuiModules.h"
#include "rn-gpui-sys/src/lib.rs.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

namespace rngpui {
extern "C" uint64_t rn_gpui_mount_batches_in_flight() noexcept;
extern "C" void rn_gpui_mount_batch_applied() noexcept;

/// Counts what is on its way to the mount batch counter the test driver reads:
/// a renderer that computes commits off the mounting path reports them here.
void setMountPendingProbe(uint64_t (*probe)());

void rn_gpui_register_app_components(
    facebook::react::ComponentDescriptorProviderRegistry& registry);

using namespace facebook::react;

class GpuiImageLoader final : public IImageLoader {
 public:
  void loadImage(
      const std::string& uri,
      const IImageLoaderOnLoadCallback&& onLoad) override;
  CacheStatus getCacheStatus(const std::string& uri) override;
  static void
  completeRequest(std::uint64_t, double, double, const std::string&);
  static void loadWithProgress(
      const std::string& uri,
      GpuiImageProgress&& progress,
      GpuiImageDone&& done);
  static void reportProgress(std::uint64_t, std::int64_t, std::int64_t);

 private:
  inline static std::atomic<std::uint64_t> nextRequestId_{1};
  inline static std::mutex mutex_;
  inline static std::unordered_map<std::uint64_t, IImageLoaderOnLoadCallback>
      callbacks_;
  inline static std::unordered_map<std::uint64_t, GpuiImageProgress>
      progressCallbacks_;
};

class GpuiMountingManager : public IMountingManager {
 public:
  /// `contentSize` returns the size a surface's root was laid out at, or
  /// nothing when the surface is not running. It is asked once per mount batch,
  /// which is what a `FitContent` surface reports back to GPUI.
  explicit GpuiMountingManager(
      std::function<void(SurfaceId)>&& onAfterMount,
      std::function<std::optional<facebook::react::Size>(SurfaceId)>&&
          contentSize = nullptr)
      : onAfterMount_(std::move(onAfterMount)),
        contentSize_(std::move(contentSize)) {}

  void executeMount(SurfaceId surfaceId, MountingTransaction&& tx) override;
  /// What `executeMount` does with a transaction's mutations. The Loom host
  /// describes its batches as mutations and applies them through this.
  void applyMutations(
      SurfaceId surfaceId,
      const ShadowViewMutationList& mutations);
  /// What a host that keeps its own node bookkeeping (the Loom host) builds a
  /// mount batch with: `beginBatch` for the surface, ops pushed by the caller,
  /// `observeMutation` for each typed Fabric mutation it described, and
  /// `submitBatch` to hand the result to the Rust store.
  MountBatch beginBatch(SurfaceId surfaceId);
  void submitBatch(SurfaceId surfaceId, MountBatch&& batch);
  void observeMutation(SurfaceId surfaceId, const ShadowViewMutation& mutation);
  /// The state a host component or a modal reports sizes into, which Rust
  /// updates by tag; forgotten with `clearComponentState`.
  void setComponentState(
      Tag tag,
      std::string_view componentName,
      ComponentHandle componentHandle,
      const State::Shared& state);
  void clearComponentState(Tag tag);
  void notifyFrameChanged(SurfaceId surfaceId, const ShadowView& view);
  void notifyDeleted(Tag tag);

  /// A node's size and transform origin, which resolve an animated transform.
  struct AnimatedGeometry {
    facebook::react::Size size;
    facebook::react::TransformOrigin transformOrigin;
  };
  /// Where a host that keeps its own nodes takes events, wheel events and
  /// animated geometry from, in place of the emitters and views this manager
  /// records from Fabric mutations.
  struct Routes {
    std::function<void(Tag, const std::string&, folly::dynamic&&)> event;
    std::function<void(Tag, uint64_t, folly::dynamic&&)> wheel;
    std::function<std::optional<AnimatedGeometry>(Tag)> geometry;
  };
  void setRoutes(Routes routes) {
    routes_ = std::move(routes);
  }
  /// Called with true when a React instance comes up and with false when it is
  /// torn down, before a reload.
  void setInstanceHook(std::function<void(bool)> hook) {
    instanceHook_ = std::move(hook);
  }
  void synchronouslyUpdateViewOnUIThread(Tag tag, const folly::dynamic& props)
      override;
  void dispatchCommand(
      const ShadowView& view,
      const std::string& name,
      const folly::dynamic& args) override;
  void dispatchCommand(
      Tag tag,
      std::string_view componentName,
      ComponentHandle componentHandle,
      const std::string& name,
      const folly::dynamic& args);
  ComponentRegistryFactory getComponentRegistryFactory() override;
  bool hasComponent(const std::string& name) override;
  std::shared_ptr<IImageLoader> getImageLoader() noexcept override {
    return imageLoader_;
  }

  // ReactHost calls this with a real executor once a fresh instance
  // is up (`ReactHost.cpp`, createReactInstance) and with `nullptr` when it
  // tears the instance down (destroyReactInstance, i.e. every reload). The
  // teardown call is the only surface-lifecycle signal the C++ platform gets:
  // stopping a surface emits no Delete mutations (`SurfaceManager::stopSurface`
  // → `Scheduler::unregisterSurface`), so it is where the Rust store is told to
  // drop the whole tree before the reloaded instance mounts over it.
  void setSchedulerTaskExecutor(
      SchedulerTaskExecutor&& executor) noexcept override;

  // Called from the GPUI main thread via GpuiHost::dispatch_event.
  void
  dispatchEvent(Tag tag, const std::string& type, folly::dynamic&& payload);
  void dispatchWheel(Tag tag, uint64_t id, folly::dynamic&& payload);
  /// Delivers a wheel event through `emitter` and reports whether JavaScript
  /// prevented it.
  static void dispatchWheelTo(
      const EventEmitter& emitter,
      uint64_t id,
      folly::dynamic&& payload);
  void setScrollOffset(Tag tag, float x, float y);

  /// Pushes a size a host component reported into its shadow node's state,
  /// which is what `measureContent` reads, and asks for a commit so Yoga
  /// re-measures. A size equal to the state's current one is dropped here, by
  /// comparing against the state data rather than a second copy of it.
  void setHostComponentSize(Tag tag, float width, float height);

  /// Pushes a container's reported insets into its shadow node's state, where
  /// `adopt` applies them as Yoga padding. Insets equal to the state's current
  /// ones are dropped here, for the same reason.
  void setHostComponentInsets(
      Tag tag,
      float top,
      float right,
      float bottom,
      float left);
  /// Pushes the size a native root measured into its shadow node's state, where
  /// `adopt` applies it to Yoga's style. A size the state already holds is
  /// dropped here. Whether the node is known.
  bool setNativeRootSize(
      Tag tag,
      float height,
      bool hasWidth,
      float width,
      float minWidth);
  /// Pushes the size a slot's placeholder was laid out at into the slot's
  /// shadow node's state. Whether the node is known.
  bool setNativeSlotSize(
      Tag tag,
      bool hasWidth,
      float width,
      bool hasHeight,
      float height);
  void setWindowSize(float width, float height);
  void setWindowTopInset(float top);
  void setAccessibilityFocusedView(Tag viewTag) override;
  void accessibleClickAction(Tag viewTag) override;

 private:
  std::function<void(SurfaceId)> onAfterMount_;
  std::function<void(bool)> instanceHook_;
  std::function<std::optional<facebook::react::Size>(SurfaceId)> contentSize_;
  std::shared_ptr<GpuiImageLoader> imageLoader_ =
      std::make_shared<GpuiImageLoader>();
  Routes routes_;
  std::mutex emittersMutex_;
  std::unordered_map<Tag, ShadowView> animatedViews_;
  std::unordered_map<Tag, SharedEventEmitter>
      emitters_; // written on JS thread, read on main
  std::unordered_map<Tag, std::shared_ptr<const ConcreteState<ScrollViewState>>>
      scrollStates_;
  std::unordered_map<
      Tag,
      std::shared_ptr<const ConcreteState<ModalHostViewState>>>
      modalStates_;
  std::unordered_map<
      Tag,
      std::shared_ptr<const ConcreteState<GpuiHostStateData>>>
      hostStates_;
  std::unordered_map<Tag, std::shared_ptr<const ConcreteState<NativeRootState>>>
      nativeRootStates_;
  std::unordered_map<Tag, std::shared_ptr<const ConcreteState<NativeSlotState>>>
      nativeSlotStates_;
  struct ImageObservation {
    std::shared_ptr<const ImageResponseObserverCoordinator> coordinator;
    std::shared_ptr<const ImageResponseObserver> observer;
  };
  std::unordered_map<Tag, ImageObservation> imageObservations_;
};
} // namespace rngpui
