#include "GpuiRustTurboModules.h"
#include "GpuiDynamic.h"
#include "GpuiModules.h"
#include "GpuiTurboModule.h"
#include "rn-gpui-sys/src/lib.rs.h"

#include <jsi/jsi.h>
#include <react/bridging/ArrayBuffer.h>
#include <react/bridging/Bridging.h>
#include <react/bridging/EventEmitter.h>
#include <react/bridging/Function.h>
#include <react/nativemodule/core/ReactCommon/TurboModule.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace rngpui {
using namespace facebook::react;

namespace {

namespace jsi = facebook::jsi;

/// A copy of one node tree, so a value built in a scope can cross to the JS
/// thread after the scope is closed. `folly::dynamic` cannot hold the bytes of
/// an `ArrayBuffer`.
struct NodeValue {
  uint8_t kind{DynamicNull};
  bool flag{false};
  double number{0.0};
  std::string text;
  std::vector<uint8_t> bytes;
  std::vector<std::pair<std::string, NodeValue>> children;
};

NodeValue nodeValueFromScope(uint32_t scope, uint32_t node) {
  NodeValue value;
  value.kind = dynamic_node_kind(scope, node);
  switch (value.kind) {
    case DynamicBool:
      value.flag = dynamic_node_bool(scope, node);
      break;
    case DynamicNumber:
      value.number = dynamic_node_number(scope, node);
      break;
    case DynamicString: {
      const rust::String text = dynamic_node_text(scope, node);
      value.text.assign(text.data(), text.size());
      break;
    }
    case DynamicBuffer: {
      const rust::Vec<uint8_t> bytes = dynamic_node_buffer(scope, node);
      value.bytes.assign(bytes.data(), bytes.data() + bytes.size());
      break;
    }
    case DynamicArray:
    case DynamicObject: {
      const size_t length = dynamic_node_len(scope, node);
      value.children.reserve(length);
      for (size_t index = 0; index < length; ++index) {
        const std::string key = value.kind == DynamicObject
            ? std::string(dynamic_node_key(scope, node, index))
            : std::string();
        value.children.emplace_back(
            key,
            nodeValueFromScope(scope, dynamic_node_child(scope, node, index)));
      }
      break;
    }
    default:
      break;
  }
  return value;
}

jsi::Value jsiValueFromNodeValue(jsi::Runtime& rt, const NodeValue& value) {
  switch (value.kind) {
    case DynamicBool:
      return jsi::Value(value.flag);
    case DynamicNumber:
      return jsi::Value(value.number);
    case DynamicString:
      return jsi::String::createFromUtf8(rt, value.text);
    case DynamicBuffer:
      return {
          rt,
          rt.createArrayBuffer(
              std::make_shared<facebook::react::detail::OwnedBytesBuffer>(
                  value.bytes))};
    case DynamicArray: {
      jsi::Array array(rt, value.children.size());
      for (size_t index = 0; index < value.children.size(); ++index) {
        array.setValueAtIndex(
            rt, index, jsiValueFromNodeValue(rt, value.children[index].second));
      }
      return jsi::Value(rt, array);
    }
    case DynamicObject: {
      jsi::Object object(rt);
      for (const auto& child : value.children) {
        object.setProperty(
            rt, child.first.c_str(), jsiValueFromNodeValue(rt, child.second));
      }
      return jsi::Value(rt, object);
    }
    default:
      return jsi::Value::null();
  }
}

/// Writes a JS value into a scope, following arrays and objects so an
/// `ArrayBuffer` nested in either keeps its bytes.
uint32_t
nodeFromJsValue(jsi::Runtime& rt, uint32_t scope, const jsi::Value& value) {
  if (value.isNull() || value.isUndefined()) {
    return dynamic_node_new(scope, DynamicNull);
  }
  if (value.isBool()) {
    const uint32_t node = dynamic_node_new(scope, DynamicBool);
    dynamic_node_set_bool(scope, node, value.getBool());
    return node;
  }
  if (value.isNumber()) {
    const uint32_t node = dynamic_node_new(scope, DynamicNumber);
    dynamic_node_set_number(scope, node, value.getNumber());
    return node;
  }
  if (value.isString()) {
    const uint32_t node = dynamic_node_new(scope, DynamicString);
    dynamic_node_set_text(scope, node, value.getString(rt).utf8(rt));
    return node;
  }
  if (value.isObject()) {
    const jsi::Object object = value.getObject(rt);
    if (object.isArrayBuffer(rt)) {
      const jsi::ArrayBuffer buffer = object.getArrayBuffer(rt);
      const uint8_t* data = buffer.data(rt);
      const uint32_t node = dynamic_node_new(scope, DynamicBuffer);
      dynamic_node_set_buffer(
          scope, node, rust::Slice<const uint8_t>(data, buffer.size(rt)));
      return node;
    }
    if (object.isFunction(rt)) {
      // Only a parameter the spec declares as a callback is a JS function.
      return dynamic_node_new(scope, DynamicNull);
    }
    if (object.isArray(rt)) {
      const jsi::Array array = object.getArray(rt);
      const uint32_t node = dynamic_node_new(scope, DynamicArray);
      for (size_t index = 0; index < array.size(rt); ++index) {
        dynamic_node_append(
            scope,
            node,
            nodeFromJsValue(rt, scope, array.getValueAtIndex(rt, index)),
            rust::Str());
      }
      return node;
    }
    const uint32_t node = dynamic_node_new(scope, DynamicObject);
    const jsi::Array names = object.getPropertyNames(rt);
    for (size_t index = 0; index < names.size(rt); ++index) {
      const std::string key =
          names.getValueAtIndex(rt, index).asString(rt).utf8(rt);
      dynamic_node_append(
          scope,
          node,
          nodeFromJsValue(rt, scope, object.getProperty(rt, key.c_str())),
          key);
    }
    return node;
  }
  return dynamic_node_new(scope, DynamicNull);
}

/// A Rust promise result. A `Promise<void>` resolves with `undefined`, which a
/// node cannot express on its own.
struct RustPromiseResult {
  std::optional<NodeValue> value;
};

struct PendingCall {
  rngpui::Promise<RustPromiseResult> promise;
  bool returnsVoid{false};
};

std::mutex& pendingMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_map<int32_t, PendingCall>& pendingCalls() {
  static std::unordered_map<int32_t, PendingCall> calls;
  return calls;
}

std::atomic<int32_t>& nextRequestId() {
  static std::atomic<int32_t> next{1};
  return next;
}

std::mutex& callbacksMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_map<uint64_t, AsyncCallback<>>& callbacks() {
  static std::unordered_map<uint64_t, AsyncCallback<>> map;
  return map;
}

std::atomic<uint64_t>& nextCallbackId() {
  static std::atomic<uint64_t> next{1};
  return next;
}

std::mutex& modulesMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_map<uint64_t, std::weak_ptr<class RustTurboModule>>& modules() {
  static std::unordered_map<uint64_t, std::weak_ptr<class RustTurboModule>> map;
  return map;
}

/// One generic TurboModule serves every Rust module: the method list comes from
/// the Rust registry when JS first asks for the module.
class RustTurboModule final
    : public TurboModule,
      public std::enable_shared_from_this<RustTurboModule> {
 public:
  RustTurboModule(
      std::string name,
      std::shared_ptr<CallInvoker> jsInvoker,
      uint64_t handle,
      rust::Vec<RustModuleMethod> methods,
      rust::Vec<RustModuleEvent> events)
      : TurboModule(std::move(name), std::move(jsInvoker)), handle_(handle) {
    methods_.reserve(methods.size());
    for (const auto& method : methods) {
      Method entry{
          .name = std::string(method.name),
          .argCount = method.arg_count,
          .requiredArgs = method.required_args,
          .kind = method.kind,
          .returnsVoid = method.returns_void,
          .callbackArgs = std::vector<uint32_t>(
              method.callback_args.begin(), method.callback_args.end()),
      };
      methodIndex_.emplace(entry.name, methods_.size());
      methods_.push_back(std::move(entry));
    }
    for (const auto& event : events) {
      const std::string name(event.name);
      if (event.has_value) {
        eventEmitterMap_[name] =
            std::make_shared<AsyncEventEmitter<folly::dynamic>>();
      } else {
        eventEmitterMap_[name] = std::make_shared<AsyncEventEmitter<>>();
      }
    }
  }

  /// `weak_from_this` is empty inside the constructor, and events look the
  /// module up by handle.
  void start() {
    std::lock_guard<std::mutex> lock(modulesMutex());
    modules()[handle_] = weak_from_this();
  }

  ~RustTurboModule() override {
    {
      std::lock_guard<std::mutex> lock(modulesMutex());
      modules().erase(handle_);
    }
    rn_gpui_rust_module_drop(handle_);
  }

  std::vector<jsi::PropNameID> getPropertyNames(
      jsi::Runtime& runtime) override {
    std::vector<jsi::PropNameID> names;
    names.reserve(methods_.size());
    for (const auto& method : methods_) {
      names.push_back(jsi::PropNameID::forUtf8(runtime, method.name));
    }
    return names;
  }

  void emitValueEvent(const std::string& event, NodeValue value) {
    auto found = eventEmitterMap_.find(event);
    if (found == eventEmitterMap_.end()) {
      return;
    }
    auto emitter = std::dynamic_pointer_cast<AsyncEventEmitter<folly::dynamic>>(
        found->second);
    if (!emitter) {
      return;
    }
    emitter->emit([value = std::move(value)](jsi::Runtime& rt) -> jsi::Value {
      return jsiValueFromNodeValue(rt, value);
    });
  }

  void emitVoidEvent(const std::string& event) {
    auto found = eventEmitterMap_.find(event);
    if (found == eventEmitterMap_.end()) {
      return;
    }
    auto emitter =
        std::dynamic_pointer_cast<AsyncEventEmitter<>>(found->second);
    if (emitter) {
      emitter->emit();
    }
  }

  void sendDeviceEvent(const std::string& name, NodeValue body) {
    emitDeviceEvent(
        name,
        [body = std::move(body)](
            jsi::Runtime& rt, std::vector<jsi::Value>& args) {
          args.emplace_back(jsiValueFromNodeValue(rt, body));
        });
  }

 protected:
  jsi::Value create(jsi::Runtime& runtime, const jsi::PropNameID& propName)
      override {
    const std::string name = propName.utf8(runtime);
    auto found = methodIndex_.find(name);
    if (found == methodIndex_.end()) {
      return TurboModule::create(runtime, propName);
    }
    const size_t index = found->second;
    return jsi::Function::createFromHostFunction(
        runtime,
        propName,
        static_cast<unsigned int>(methods_[index].argCount),
        [this, index](
            jsi::Runtime& rt,
            const jsi::Value&,
            const jsi::Value* args,
            size_t count) { return invoke(rt, index, args, count); });
  }

 private:
  struct Method {
    std::string name;
    uint32_t argCount;
    uint32_t requiredArgs;
    uint8_t kind;
    bool returnsVoid;
    std::vector<uint32_t> callbackArgs;
  };

  class ScopeGuard {
   public:
    explicit ScopeGuard(uint32_t scope) : scope_(scope) {}
    ~ScopeGuard() {
      dynamic_scope_close(scope_);
    }
    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;

   private:
    uint32_t scope_;
  };

  void throwError(
      jsi::Runtime& rt,
      const rust::String& code,
      const rust::String& message) const {
    auto error = jsi::Value(rt, jsi::JSError(rt, std::string(message)).value());
    if (!code.empty()) {
      error.asObject(rt).setProperty(
          rt, "code", jsi::String::createFromUtf8(rt, std::string(code)));
    }
    throw jsi::JSError(rt, std::move(error));
  }

  /// A JS function cannot be a value, so the id of a stored
  /// `AsyncCallback` takes its place.
  uint64_t storeCallback(jsi::Runtime& rt, const jsi::Value& value) {
    auto callback =
        AsyncCallback<>(rt, value.getObject(rt).getFunction(rt), jsInvoker_);
    const uint64_t id = nextCallbackId().fetch_add(1);
    std::lock_guard<std::mutex> lock(callbacksMutex());
    callbacks().emplace(id, std::move(callback));
    return id;
  }

  jsi::Value
  invoke(jsi::Runtime& rt, size_t index, const jsi::Value* args, size_t count) {
    const Method& method = methods_[index];
    if (count < method.requiredArgs) {
      throw jsi::JSError(
          rt,
          name_ + "." + method.name + " expects " +
              std::to_string(method.requiredArgs) + " arguments, got " +
              std::to_string(count));
    }
    const uint32_t scope = dynamic_scope_open();
    const ScopeGuard guard(scope);
    const uint32_t array = dynamic_node_new(scope, DynamicArray);
    for (uint32_t position = 0; position < method.argCount; ++position) {
      if (position >= count) {
        dynamic_node_append(
            scope, array, dynamic_node_new(scope, DynamicNull), rust::Str());
        continue;
      }
      const bool isCallback = std::find(
                                  method.callbackArgs.begin(),
                                  method.callbackArgs.end(),
                                  position) != method.callbackArgs.end();
      if (isCallback && args[position].isObject() &&
          args[position].getObject(rt).isFunction(rt)) {
        const uint64_t id = storeCallback(rt, args[position]);
        const uint32_t node = dynamic_node_new(scope, DynamicNumber);
        dynamic_node_set_number(scope, node, static_cast<double>(id));
        dynamic_node_append(scope, array, node, rust::Str());
        continue;
      }
      dynamic_node_append(
          scope,
          array,
          nodeFromJsValue(rt, scope, args[position]),
          rust::Str());
    }

    switch (method.kind) {
      case 0: {
        bool ok = false;
        rust::String code;
        rust::String message;
        const uint32_t root = rn_gpui_rust_module_call_value(
            handle_,
            static_cast<uint32_t>(index),
            scope,
            array,
            ok,
            code,
            message);
        if (!ok) {
          throwError(rt, code, message);
        }
        return jsiValueFromNodeValue(rt, nodeValueFromScope(scope, root));
      }
      case 1: {
        bool ok = false;
        rust::String code;
        rust::String message;
        rn_gpui_rust_module_call_void(
            handle_,
            static_cast<uint32_t>(index),
            scope,
            array,
            ok,
            code,
            message);
        if (!ok) {
          throwError(rt, code, message);
        }
        return jsi::Value::undefined();
      }
      default: {
        rngpui::Promise<RustPromiseResult> promise(rt, jsInvoker_);
        const int32_t request = nextRequestId().fetch_add(1);
        {
          std::lock_guard<std::mutex> lock(pendingMutex());
          pendingCalls().emplace(
              request, PendingCall{promise, method.returnsVoid});
        }
        rn_gpui_rust_module_call_promise(
            handle_, static_cast<uint32_t>(index), scope, array, request);
        return promise.get(rt);
      }
    }
  }

  uint64_t handle_;
  std::vector<Method> methods_;
  std::unordered_map<std::string, size_t> methodIndex_;
};

std::shared_ptr<RustTurboModule> moduleFor(uint64_t handle) {
  std::lock_guard<std::mutex> lock(modulesMutex());
  auto found = modules().find(handle);
  if (found == modules().end()) {
    return nullptr;
  }
  return found->second.lock();
}

std::vector<NodeValue> arrayFromNode(uint32_t scope, uint32_t node) {
  std::vector<NodeValue> values;
  const size_t length = dynamic_node_len(scope, node);
  values.reserve(length);
  for (size_t index = 0; index < length; ++index) {
    values.push_back(
        nodeValueFromScope(scope, dynamic_node_child(scope, node, index)));
  }
  return values;
}

} // namespace

} // namespace rngpui

namespace facebook::react {

template <>
struct Bridging<rngpui::RustPromiseResult> {
  static jsi::Value toJs(
      jsi::Runtime& rt,
      const rngpui::RustPromiseResult& result,
      const std::shared_ptr<CallInvoker>&) {
    if (!result.value) {
      return jsi::Value::undefined();
    }
    return jsiValueFromNodeValue(rt, *result.value);
  }
};

} // namespace facebook::react

namespace rngpui {

void rn_gpui_rust_module_result(
    int32_t request,
    bool ok,
    uint32_t scope,
    uint32_t root,
    rust::String code,
    rust::String message) {
  std::optional<PendingCall> pending;
  {
    std::lock_guard<std::mutex> lock(pendingMutex());
    auto found = pendingCalls().find(request);
    if (found == pendingCalls().end()) {
      // The JS promise is gone: the runtime was torn down by a reload.
      dynamic_scope_close(scope);
      return;
    }
    pending = std::move(found->second);
    pendingCalls().erase(found);
  }
  if (ok) {
    if (pending->returnsVoid || root == kDynamicNoNode) {
      pending->promise.resolve(RustPromiseResult{std::nullopt});
    } else {
      pending->promise.resolve(
          RustPromiseResult{nodeValueFromScope(scope, root)});
    }
  } else {
    pending->promise.reject(std::string(code), std::string(message));
  }
  dynamic_scope_close(scope);
}

void rn_gpui_rust_callback_invoke(uint64_t id, uint32_t scope, uint32_t root) {
  std::optional<AsyncCallback<>> callback;
  {
    std::lock_guard<std::mutex> lock(callbacksMutex());
    auto found = callbacks().find(id);
    if (found == callbacks().end()) {
      dynamic_scope_close(scope);
      return;
    }
    callback = std::move(found->second);
    callbacks().erase(found);
  }
  auto args =
      std::make_shared<std::vector<NodeValue>>(arrayFromNode(scope, root));
  dynamic_scope_close(scope);
  callback->call([args](jsi::Runtime& rt, jsi::Function& function) {
    std::vector<jsi::Value> values;
    values.reserve(args->size());
    for (const auto& value : *args) {
      values.push_back(jsiValueFromNodeValue(rt, value));
    }
    const jsi::Value* first = values.data();
    function.call(rt, first, values.size());
  });
}

void rn_gpui_rust_callback_drop(uint64_t id) {
  std::lock_guard<std::mutex> lock(callbacksMutex());
  callbacks().erase(id);
}

void rn_gpui_rust_module_emit(
    uint64_t handle,
    rust::Str event,
    bool has_value,
    uint32_t scope,
    uint32_t root) {
  auto module = moduleFor(handle);
  if (!module) {
    dynamic_scope_close(scope);
    return;
  }
  const std::string name(event);
  if (has_value) {
    module->emitValueEvent(name, nodeValueFromScope(scope, root));
  } else {
    module->emitVoidEvent(name);
  }
  dynamic_scope_close(scope);
}

void rn_gpui_rust_module_send_event(
    uint64_t handle,
    rust::Str name,
    uint32_t scope,
    uint32_t root) {
  auto module = moduleFor(handle);
  if (!module) {
    dynamic_scope_close(scope);
    return;
  }
  module->sendDeviceEvent(std::string(name), nodeValueFromScope(scope, root));
  dynamic_scope_close(scope);
}

void rn_gpui_rust_module_clear_pending() {
  {
    std::lock_guard<std::mutex> lock(pendingMutex());
    pendingCalls().clear();
  }
  {
    std::lock_guard<std::mutex> lock(callbacksMutex());
    callbacks().clear();
  }
}

void install_rust_turbo_modules() {
  gpuiModuleHooks().turboModules.push_back(
      [](const std::string& name, const std::shared_ptr<CallInvoker>& jsInvoker)
          -> std::shared_ptr<TurboModule> {
        const uint64_t handle = rn_gpui_rust_module_create(rust::Str(name));
        if (handle == 0) {
          return nullptr;
        }
        auto module = std::make_shared<RustTurboModule>(
            name,
            jsInvoker,
            handle,
            rn_gpui_rust_module_methods(handle),
            rn_gpui_rust_module_events(handle));
        module->start();
        return module;
      });
}

} // namespace rngpui
