/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <vector>

#include <hermes/AsyncDebuggerAPI.h>
#include <hermes/hermes.h>

namespace facebook {
namespace hermes {
namespace cdp {

enum class PausedNotificationReason { kException, kOther, kStep };

/// Last explicit debugger step command issued by the user.
enum class UserStepRequest {
  StepInto,
  StepOver,
  StepOut,
};

class DebuggerDomainAgent;

/// Coordinates multiple DebuggerDomainAgent instances connecting to the same
/// Hermes Runtime. This class manages shared state, ensures cooperative access,
/// and eliminates race conditions when multiple agents connect concurrently.
///
/// All methods must be called on the runtime thread unless otherwise noted.
class DebuggerDomainCoordinator {
 public:
  /// Constructs a DebuggerDomainCoordinator for use with the provided
  /// HermesRuntime.
  explicit DebuggerDomainCoordinator(HermesRuntime &runtime);
  ~DebuggerDomainCoordinator();

  // Rule of Five: Non-copyable, non-movable (stable references required)
  DebuggerDomainCoordinator(const DebuggerDomainCoordinator &) = delete;
  DebuggerDomainCoordinator &operator=(const DebuggerDomainCoordinator &) =
      delete;
  DebuggerDomainCoordinator(DebuggerDomainCoordinator &&) = delete;
  DebuggerDomainCoordinator &operator=(DebuggerDomainCoordinator &&) = delete;

  //===--------------------------------------------------------------------===//
  // Agent management
  //===--------------------------------------------------------------------===//

  /// Registers a new agent with the coordinator. We will call the agent's
  /// methods to notify it of debugger events and query state set by the
  /// debugging client (like blackboxed ranges). The agent MUST call
  /// disableAgent() before being destroyed.
  void enableAgent(
      debugger::AsyncDebuggerAPI &asyncDebugger,
      DebuggerDomainAgent &agent);
  /// Unregisters an agent from the coordinator.
  void disableAgent(
      debugger::AsyncDebuggerAPI &asyncDebugger,
      DebuggerDomainAgent &agent);

  //===--------------------------------------------------------------------===//
  // Debugger control
  //===--------------------------------------------------------------------===//

  /// Used to handle Debugger.pause requests
  void pause();
  /// Used to handle Debugger.stepInto, Debugger.stepOver,
  /// and debugger.stepOut requests
  void stepFromPaused(
      debugger::AsyncDebuggerAPI &asyncDebugger,
      UserStepRequest stepRequest);
  /// Globally enables or disables pausing at breakpoints.
  void setBreakpointsActive(bool active);
  /// Returns whether the debugger is currently paused.
  bool isPaused(debugger::AsyncDebuggerAPI &asyncDebugger) const;
  /// Used to handle Debugger.resume requests
  void resume(debugger::AsyncDebuggerAPI &asyncDebugger);

 private:
  /// Handle an event originating from the runtime.
  void handleDebuggerEvent(
      HermesRuntime &runtime,
      debugger::AsyncDebuggerAPI &asyncDebugger,
      debugger::DebuggerEventType event);

  /// Called when the runtime is paused.
  void setPaused(PausedNotificationReason pausedNotificationReason);

  /// Called when the runtime is resumed.
  void setUnpaused();

  /// Obtain the newly loaded script and send a ScriptParsed notification to the
  /// enabled agents
  void processNewLoadedScript();

  /// Checks whether the location of the top frame of the call stack is
  /// blackboxed in ALL of the enabled agents (and has no manual breakpoints).
  bool isTopFrameLocationBlackboxed();

  HermesRuntime &runtime_;

  /// The set of agents that are currently enabled.
  std::vector<DebuggerDomainAgent *> enabledAgents_;

  /// Whether the currently installed breakpoints actually take effect. If
  /// they're supposed to be inactive, then we will automatically
  /// resume execution when breakpoints are hit.
  bool breakpointsActive_;

  /// Whether to consider the debugger as currently paused. There are some
  /// debugger events such as ScriptLoaded where we don't consider the debugger
  /// to be paused.
  bool paused_;

  /// Set to true when the user selects to explicitly pause execution.
  /// This is set back to false when the execution is paused.
  bool explicitPausePending_ = false;

  /// Last explicit step type issued by the user.
  /// * This is "sticky" - we can't tell if a step command was
  /// completed since a step command that does not result in further operations
  /// resolves to a "resume" without "stepFinished" or debugger pause.
  /// That means that this member should only be used in situations where we are
  /// sure that a step command was issued in the given scenario, i.e. a
  /// StepFinish event. For example, a step into command followed by a resume
  /// would leave this member holding an "StepInto" even when minutes later the
  /// execution stops on a breakpoint.
  std::optional<UserStepRequest> lastUserStepRequest_ = std::nullopt;
};

} // namespace cdp
} // namespace hermes
} // namespace facebook
