// A MessageQueueThread that runs React Native's JavaScript on the GPUI main
// thread, which is what Loom's `jsThread: "main"` selects.
#pragma once

#if LOOM_RENDERER

#include "GpuiTurboModule.h"
#include "rn-gpui-sys/src/lib.rs.h"

#include <cxxreact/MessageQueueThread.h>
#include <react/threading/MessageQueueThreadImpl.h>

#include <atomic>
#include <exception>
#include <functional>
#include <future>
#include <memory>

namespace rngpui {

class GpuiMainMessageQueue final : public facebook::react::MessageQueueThread {
 public:
  void runOnQueue(std::function<void()>&& task) override {
    dispatchMain(
        [state = state_,
         task = facebook::react::trackJsTask(std::move(task))]() mutable {
          if (!state->quit.load()) {
            task();
          }
        });
  }

  /// Runs `task` inline on the main thread. From another thread it waits for
  /// the main thread to run it, so it is for initialization only.
  void runOnQueueSync(std::function<void()>&& task) override {
    if (rn_gpui_is_main_thread()) {
      task();
      return;
    }
    auto done = std::make_shared<std::promise<void>>();
    auto finished = done->get_future();
    dispatchMain([state = state_, task = std::move(task), done]() mutable {
      if (!state->quit.load()) {
        try {
          task();
        } catch (...) {
          done->set_exception(std::current_exception());
          return;
        }
      }
      done->set_value();
    });
    finished.get();
  }

  /// Once this returns no further work runs: queued tasks see the flag, and a
  /// task already running on the main thread has finished.
  void quitSynchronous() override {
    state_->quit.store(true);
    if (rn_gpui_is_main_thread()) {
      return;
    }
    auto done = std::make_shared<std::promise<void>>();
    auto finished = done->get_future();
    dispatchMain([done] { done->set_value(); });
    finished.wait();
  }

 private:
  struct State {
    std::atomic<bool> quit{false};
  };
  std::shared_ptr<State> state_ = std::make_shared<State>();
};

} // namespace rngpui

#endif
