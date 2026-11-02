#include "GpuiHost.h"
#include "GpuiModules.h"

#include <GPUIGestureHandlerSpec.h>
#include <ReactCommon/TurboModule.h>
#include <folly/dynamic.h>
#include <folly/json.h>
#include <glog/logging.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {
using facebook::jsi::Runtime;
using facebook::react::TurboModule;
using rngpui::extension::RawPointerEvent;
using rngpui::extension::RecognizedGesture;

constexpr int32_t kUndetermined = 0;
constexpr int32_t kFailed = 1;
constexpr int32_t kBegan = 2;
constexpr int32_t kCancelled = 3;
constexpr int32_t kActive = 4;
constexpr int32_t kEnd = 5;

struct Handler {
  std::string name;
  folly::dynamic config{folly::dynamic::object};
  int32_t viewTag{-1};
  int32_t actionType{0};
  int32_t state{kUndetermined};
  float startX{0};
  float startY{0};
  float lastX{0};
  float lastY{0};
  double startTime{0};
  double lastTime{0};
  bool recognized{false};
  std::vector<int32_t> simultaneousHandlers;
  std::vector<int32_t> waitFor;
  std::vector<int32_t> blocksHandlers;
};

std::mutex handlersMutex;
std::unordered_map<int32_t, Handler> handlers;

folly::dynamic configObject(folly::dynamic config) {
  return config.isObject() ? std::move(config) : folly::dynamic::object();
}

float number(const folly::dynamic& object, const char* key, float fallback) {
  if (!object.isObject() || !object.get_ptr(key))
    return fallback;
  const auto& value = object[key];
  if (value.isNumber())
    return static_cast<float>(value.asDouble());
  return fallback;
}

bool enabled(const Handler& handler) {
  const auto* value = handler.config.get_ptr("enabled");
  return value == nullptr || !value->isBool() || value->asBool();
}

bool isPan(const Handler& handler) {
  return handler.name == "Pan" || handler.name == "PanGestureHandler";
}

bool isTap(const Handler& handler) {
  return handler.name == "Tap" || handler.name == "TapGestureHandler";
}

bool isLongPress(const Handler& handler) {
  return handler.name == "LongPress" ||
      handler.name == "LongPressGestureHandler";
}

bool gestureTracingEnabled() {
  return std::getenv("RN_GPUI_DEBUG_GESTURES") != nullptr;
}

folly::dynamic payloadFor(
    int32_t handlerTag,
    const Handler& handler,
    int32_t state,
    int32_t oldState,
    const RawPointerEvent& pointer,
    bool stateChange) {
  const float dx = pointer.x - handler.startX;
  const float dy = pointer.y - handler.startY;
  const double elapsed = std::max(1.0, pointer.timestamp - handler.lastTime);
  folly::dynamic payload = folly::dynamic::object("handlerTag", handlerTag)(
      "state", state)("x", pointer.x - handler.startX)(
      "y", pointer.y - handler.startY)("absoluteX", pointer.x)(
      "absoluteY", pointer.y)("translationX", dx)("translationY", dy)(
      "velocityX", (pointer.x - handler.lastX) * 1000.0 / elapsed)(
      "velocityY", (pointer.y - handler.lastY) * 1000.0 / elapsed)(
      "numberOfPointers", 1)("pointerType", 2)(
      "duration", pointer.timestamp - handler.startTime);
  if (stateChange) {
    payload["oldState"] = oldState;
  }
  return payload;
}

void appendEvent(
    std::vector<RecognizedGesture>& events,
    int32_t viewTag,
    const char* type,
    const folly::dynamic& payload) {
  events.push_back({viewTag, type, folly::toJson(payload)});
}

void appendState(
    std::vector<RecognizedGesture>& events,
    int32_t handlerTag,
    Handler& handler,
    int32_t nextState,
    const RawPointerEvent& pointer) {
  if (handler.state == nextState)
    return;
  const auto oldState = handler.state;
  handler.state = nextState;
  if (nextState == kActive) {
    handler.recognized = true;
  }
  appendEvent(
      events,
      handler.viewTag,
      "topGestureHandlerStateChange",
      payloadFor(handlerTag, handler, nextState, oldState, pointer, true));
}

std::vector<int32_t> relationTags(
    const folly::dynamic& relations,
    const char* key) {
  std::vector<int32_t> tags;
  const auto* values = relations.get_ptr(key);
  if (values == nullptr || !values->isArray()) {
    return tags;
  }
  tags.reserve(values->size());
  for (const auto& value : *values) {
    if (value.isInt()) {
      tags.push_back(static_cast<int32_t>(value.asInt()));
    }
  }
  return tags;
}

bool hasTag(const std::vector<int32_t>& tags, int32_t tag) {
  return std::find(tags.begin(), tags.end(), tag) != tags.end();
}

bool hasRecognizedWaitFor(const Handler& handler) {
  for (const auto tag : handler.waitFor) {
    const auto dependency = handlers.find(tag);
    if (dependency != handlers.end() && dependency->second.recognized) {
      return true;
    }
  }
  return false;
}

bool hasUnresolvedWaitFor(const Handler& handler) {
  for (const auto tag : handler.waitFor) {
    const auto dependency = handlers.find(tag);
    if (dependency != handlers.end() && dependency->second.state == kBegan &&
        !dependency->second.recognized) {
      return true;
    }
  }
  return false;
}

bool blockedByActiveHandler(int32_t handlerTag) {
  for (const auto& [otherTag, other] : handlers) {
    if (otherTag != handlerTag && other.state == kActive &&
        hasTag(other.blocksHandlers, handlerTag)) {
      return true;
    }
  }
  return false;
}

std::vector<RecognizedGesture> processPointer(const RawPointerEvent& pointer) {
  std::vector<RecognizedGesture> events;
  std::lock_guard<std::mutex> lock(handlersMutex);
  if (gestureTracingEnabled() && pointer.phase != 4) {
    LOG(INFO) << "[gesture-handler] pointer phase=" << pointer.phase << " at ("
              << pointer.x << ',' << pointer.y
              << ") chain=" << pointer.targetChain.size() << " tags";
  }
  if (pointer.phase == 0) {
    for (auto& [_, handler] : handlers) {
      if (!enabled(handler) || handler.viewTag < 0 ||
          std::find(
              pointer.targetChain.begin(),
              pointer.targetChain.end(),
              handler.viewTag) == pointer.targetChain.end()) {
        continue;
      }
      handler.state = kUndetermined;
      handler.startX = pointer.x;
      handler.startY = pointer.y;
      handler.lastX = pointer.x;
      handler.lastY = pointer.y;
      handler.startTime = pointer.timestamp;
      handler.lastTime = pointer.timestamp;
      handler.recognized = false;
      appendState(events, _, handler, kBegan, pointer);
      if (gestureTracingEnabled()) {
        LOG(INFO) << "[gesture-handler] began handler=" << _
                  << " name=" << handler.name << " view=" << handler.viewTag;
      }
    }
    return events;
  }

  if (pointer.phase == 2) {
    // Resolve recognizers that cannot succeed on release before testing tap
    // handlers that may be waiting for them to fail.
    for (auto& [handlerTag, handler] : handlers) {
      if (handler.state != kBegan || isTap(handler)) {
        continue;
      }
      const float dx = pointer.x - handler.startX;
      const float dy = pointer.y - handler.startY;
      if (isLongPress(handler)) {
        const auto elapsed = pointer.timestamp - handler.startTime;
        const auto minDuration =
            number(handler.config, "minDurationMs", 500.0f);
        if (elapsed >= minDuration &&
            std::hypot(dx, dy) <= number(handler.config, "maxDist", 10.0f) &&
            !hasRecognizedWaitFor(handler) &&
            !blockedByActiveHandler(handlerTag)) {
          appendState(events, handlerTag, handler, kActive, pointer);
        } else {
          appendState(events, handlerTag, handler, kFailed, pointer);
        }
      } else {
        appendState(events, handlerTag, handler, kFailed, pointer);
      }
    }
  }

  for (auto& [handlerTag, handler] : handlers) {
    if (handler.state != kBegan && handler.state != kActive)
      continue;
    if (pointer.phase == 4) {
      const float dx = pointer.x - handler.startX;
      const float dy = pointer.y - handler.startY;
      const auto elapsed = pointer.timestamp - handler.startTime;
      const auto minDuration = number(handler.config, "minDurationMs", 500.0f);
      if (gestureTracingEnabled() && handler.state == kBegan &&
          isLongPress(handler) && elapsed >= minDuration) {
        LOG(INFO) << "[gesture-handler] long-press threshold handler="
                  << handlerTag << " elapsed=" << elapsed
                  << " required=" << minDuration
                  << " distance=" << std::hypot(dx, dy);
      }
      if (handler.state == kBegan && isLongPress(handler) &&
          elapsed >= minDuration &&
          std::hypot(dx, dy) <= number(handler.config, "maxDist", 10.0f)) {
        if (hasRecognizedWaitFor(handler) ||
            blockedByActiveHandler(handlerTag)) {
          appendState(events, handlerTag, handler, kFailed, pointer);
        } else if (!hasUnresolvedWaitFor(handler)) {
          appendState(events, handlerTag, handler, kActive, pointer);
        }
      }
    } else if (pointer.phase == 1) {
      const float dx = pointer.x - handler.startX;
      const float dy = pointer.y - handler.startY;
      if (handler.state == kBegan && isPan(handler) &&
          std::hypot(dx, dy) >= number(handler.config, "minDist", 3.0f)) {
        if (hasRecognizedWaitFor(handler) ||
            blockedByActiveHandler(handlerTag)) {
          appendState(events, handlerTag, handler, kFailed, pointer);
        } else if (!hasUnresolvedWaitFor(handler)) {
          appendState(events, handlerTag, handler, kActive, pointer);
        }
      } else if (
          handler.state == kBegan && isLongPress(handler) &&
          pointer.timestamp - handler.startTime >=
              number(handler.config, "minDurationMs", 500.0f) &&
          std::hypot(dx, dy) <= number(handler.config, "maxDist", 10.0f)) {
        if (hasRecognizedWaitFor(handler) ||
            blockedByActiveHandler(handlerTag)) {
          appendState(events, handlerTag, handler, kFailed, pointer);
        } else if (!hasUnresolvedWaitFor(handler)) {
          appendState(events, handlerTag, handler, kActive, pointer);
        }
      }
      if (handler.state == kActive &&
          (isPan(handler) || isLongPress(handler))) {
        appendEvent(
            events,
            handler.viewTag,
            "topGestureHandlerEvent",
            payloadFor(
                handlerTag,
                handler,
                handler.state,
                kUndetermined,
                pointer,
                false));
      }
    } else if (pointer.phase == 2) {
      const float dx = pointer.x - handler.startX;
      const float dy = pointer.y - handler.startY;
      if (isTap(handler) && handler.state == kBegan &&
          pointer.timestamp - handler.startTime <=
              number(handler.config, "maxDurationMs", 500.0f) &&
          std::hypot(dx, dy) <= number(handler.config, "maxDist", 10.0f)) {
        if (hasRecognizedWaitFor(handler) ||
            blockedByActiveHandler(handlerTag)) {
          appendState(events, handlerTag, handler, kFailed, pointer);
        } else if (!hasUnresolvedWaitFor(handler)) {
          appendState(events, handlerTag, handler, kActive, pointer);
        } else {
          appendState(events, handlerTag, handler, kFailed, pointer);
        }
      } else if (
          isLongPress(handler) && handler.state == kBegan &&
          pointer.timestamp - handler.startTime >=
              number(handler.config, "minDurationMs", 500.0f) &&
          std::hypot(dx, dy) <= number(handler.config, "maxDist", 10.0f)) {
        appendState(events, handlerTag, handler, kActive, pointer);
      } else if (handler.state == kBegan) {
        appendState(events, handlerTag, handler, kFailed, pointer);
      }
      if (handler.state == kActive) {
        if (isTap(handler) || isLongPress(handler)) {
          appendEvent(
              events,
              handler.viewTag,
              "topGestureHandlerEvent",
              payloadFor(
                  handlerTag,
                  handler,
                  handler.state,
                  kUndetermined,
                  pointer,
                  false));
        }
        appendState(events, handlerTag, handler, kEnd, pointer);
      }
      handler.lastX = pointer.x;
      handler.lastY = pointer.y;
      handler.lastTime = pointer.timestamp;
    } else if (pointer.phase == 3) {
      appendState(
          events,
          handlerTag,
          handler,
          handler.state == kActive ? kCancelled : kFailed,
          pointer);
    }
  }
  if (gestureTracingEnabled() && (pointer.phase != 4 || !events.empty())) {
    LOG(INFO) << "[gesture-handler] recognized events=" << events.size();
  }
  return events;
}

class GPUIGestureHandlerModule final
    : public facebook::react::NativeRNGestureHandlerModuleSpec<
          GPUIGestureHandlerModule> {
 public:
  explicit GPUIGestureHandlerModule(
      std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
      : NativeRNGestureHandlerModuleSpec(std::move(jsInvoker)) {}

  // The JS side queues operations and flushes them in order, so every method
  // has to observe the same order the JS thread produced.
  static constexpr rngpui::ModuleThread kThread = rngpui::ModuleThread::JS;

  void createGestureHandler(
      Runtime&,
      std::string handlerName,
      double handlerTag,
      folly::dynamic config) {
    Handler handler;
    handler.name = std::move(handlerName);
    handler.config = configObject(std::move(config));
    std::lock_guard<std::mutex> lock(handlersMutex);
    handlers.insert_or_assign(
        static_cast<int32_t>(handlerTag), std::move(handler));
  }

  void attachGestureHandler(
      Runtime&,
      double handlerTag,
      double viewTag,
      double actionType) {
    const auto tag = static_cast<int32_t>(handlerTag);
    std::lock_guard<std::mutex> lock(handlersMutex);
    auto found = handlers.find(tag);
    if (found != handlers.end()) {
      found->second.viewTag = static_cast<int32_t>(viewTag);
      found->second.actionType = static_cast<int32_t>(actionType);
      if (gestureTracingEnabled()) {
        LOG(INFO) << "[gesture-handler] attached handler=" << tag
                  << " view=" << found->second.viewTag
                  << " action=" << found->second.actionType;
      }
    }
  }

  void setGestureHandlerConfig(
      Runtime&,
      double handlerTag,
      folly::dynamic newConfig) {
    const auto tag = static_cast<int32_t>(handlerTag);
    auto config = configObject(std::move(newConfig));
    std::lock_guard<std::mutex> lock(handlersMutex);
    auto found = handlers.find(tag);
    if (found != handlers.end())
      found->second.config = std::move(config);
  }

  void updateGestureHandlerConfig(
      Runtime&,
      double handlerTag,
      folly::dynamic newConfig) {
    const auto tag = static_cast<int32_t>(handlerTag);
    std::lock_guard<std::mutex> lock(handlersMutex);
    auto found = handlers.find(tag);
    if (found != handlers.end() && newConfig.isObject()) {
      for (const auto& [key, value] : newConfig.items())
        found->second.config[key] = value;
    }
  }

  void
  configureRelations(Runtime&, double handlerTag, folly::dynamic relations) {
    const auto tag = static_cast<int32_t>(handlerTag);
    std::lock_guard<std::mutex> lock(handlersMutex);
    const auto found = handlers.find(tag);
    if (found != handlers.end()) {
      found->second.simultaneousHandlers =
          relationTags(relations, "simultaneousHandlers");
      found->second.waitFor = relationTags(relations, "waitFor");
      found->second.blocksHandlers = relationTags(relations, "blocksHandlers");
      if (gestureTracingEnabled()) {
        auto formatTags = [](const std::vector<int32_t>& tags) {
          std::string result;
          for (const auto value : tags) {
            if (!result.empty())
              result += ",";
            result += std::to_string(value);
          }
          return result;
        };
        LOG(INFO) << "[gesture-handler] relations handler=" << tag
                  << " name=" << found->second.name << " simultaneous="
                  << formatTags(found->second.simultaneousHandlers)
                  << " waitFor=" << formatTags(found->second.waitFor)
                  << " blocks=" << formatTags(found->second.blocksHandlers);
      }
    }
  }

  void dropGestureHandler(Runtime&, double handlerTag) {
    std::lock_guard<std::mutex> lock(handlersMutex);
    handlers.erase(static_cast<int32_t>(handlerTag));
  }

  void flushOperations(Runtime&) {}

  bool installUIRuntimeBindings(Runtime&) {
    return true;
  }
};
} // namespace

std::shared_ptr<facebook::react::TurboModule>
create_gpui_gesture_handler_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  if (name != GPUIGestureHandlerModule::kModuleName) {
    return nullptr;
  }
  rngpui::registerPointerObserver(
      [](const rngpui::extension::RawPointerEvent& pointer) {
        return processPointer(pointer);
      });
  if (gestureTracingEnabled()) {
    LOG(INFO) << "[gesture-handler] native pointer processor installed";
  }
  return std::make_shared<GPUIGestureHandlerModule>(std::move(jsInvoker));
}
