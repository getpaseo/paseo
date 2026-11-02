#pragma once

#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/TurboModule.h>
#include <folly/dynamic.h>
#include <glog/logging.h>
#include <jsi/jsi.h>
#include <react/bridging/ArrayBuffer.h>
#include <react/bridging/Bridging.h>
#include <react/bridging/EventEmitter.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <tuple>
#include <type_traits>
#include <utility>
#include <vector>

namespace rngpui {

namespace jsi = facebook::jsi;

/// A JS function a module method may call from any thread. Call it at most
/// once, as an Objective-C response block is called.
template <typename... Args>
using Callback = facebook::react::AsyncCallback<Args...>;

/// The thread a module's `void` and `Promise` methods run on; methods that
/// return a value always run on the JS thread.
enum class ModuleThread {
  Own,
  Main,
  JS,
};

/// A serial task queue. `post` is callable from any thread; the worker starts
/// on the first post and stops when the queue is destroyed.
class ModuleQueue {
 public:
  explicit ModuleQueue(std::string threadName);
  ~ModuleQueue();

  ModuleQueue(const ModuleQueue&) = delete;
  ModuleQueue& operator=(const ModuleQueue&) = delete;

  void stop();

  void post(std::function<void()> task);

 private:
  struct State;
  std::shared_ptr<State> state_;
  std::string threadName_;
};

/// Runs `task` on the GPUI main thread. The task is dropped, with a warning
/// logged once, while no main-thread handler is installed.
void dispatchMain(std::function<void()> task);

/// The promise a module-thread method settles. It is created on the JS thread
/// by the spec invoker, copyable, and `resolve`/`reject` may be called from any
/// thread; only the first settlement has an effect.
template <typename... T>
class Promise {
  static_assert(sizeof...(T) <= 1, "Promise takes at most one value type");

 public:
  Promise(
      jsi::Runtime& rt,
      const std::shared_ptr<facebook::react::CallInvoker>& jsInvoker);

  void resolve(T... value);

  void reject(std::string message);

  /// The error carries `code` as its `code` property.
  void reject(std::string code, std::string message);

  /// The JS promise; only call this on the JS thread, before the module method
  /// can settle it.
  jsi::Object get(jsi::Runtime& rt) const;

 private:
  struct PromiseHolder : facebook::react::LongLivedObject {
    PromiseHolder(jsi::Runtime& rt, jsi::Object p)
        : LongLivedObject(rt), promise(std::move(p)) {}

    jsi::Object promise;
  };

  struct SharedState {
    ~SharedState() {
      if (auto holder = promiseHolder.lock()) {
        holder->allowRelease();
      }
    }

    std::mutex mutex;
    std::weak_ptr<PromiseHolder> promiseHolder;
    std::optional<facebook::react::AsyncCallback<T...>> resolve;
    std::optional<facebook::react::AsyncCallback<>> reject;
  };

  void settleReject(std::optional<std::string> code, std::string message);

  std::shared_ptr<SharedState> state_;
};

template <typename... T>
Promise<T...>::Promise(
    jsi::Runtime& rt,
    const std::shared_ptr<facebook::react::CallInvoker>& jsInvoker)
    : state_(std::make_shared<SharedState>()) {
  auto constructor = rt.global().getPropertyAsFunction(rt, "Promise");
  auto promise = constructor.callAsConstructor(
      rt,
      facebook::react::bridging::toJs(
          rt,
          // The executor runs synchronously, so capturing `this` is safe.
          [this](
              facebook::react::AsyncCallback<T...> resolve,
              const facebook::react::AsyncCallback<>& reject) {
            state_->resolve = std::move(resolve);
            state_->reject = std::move(reject);
          },
          jsInvoker));

  auto holder = std::make_shared<PromiseHolder>(rt, promise.asObject(rt));
  facebook::react::LongLivedObjectCollection::get(rt).add(holder);
  state_->promiseHolder = holder;
}

template <typename... T>
void Promise<T...>::resolve(T... value) {
  std::optional<facebook::react::AsyncCallback<T...>> callback;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (!state_->resolve) {
      return;
    }
    callback = *state_->resolve;
    state_->resolve.reset();
    state_->reject.reset();
  }
  callback->call(std::forward<T>(value)...);
}

template <typename... T>
void Promise<T...>::reject(std::string message) {
  settleReject(std::nullopt, std::move(message));
}

template <typename... T>
void Promise<T...>::reject(std::string code, std::string message) {
  settleReject(std::move(code), std::move(message));
}

template <typename... T>
void Promise<T...>::settleReject(
    std::optional<std::string> code,
    std::string message) {
  std::optional<facebook::react::AsyncCallback<>> callback;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (!state_->reject) {
      return;
    }
    callback = *state_->reject;
    state_->resolve.reset();
    state_->reject.reset();
  }
  callback->call([code = std::move(code), message = std::move(message)](
                     jsi::Runtime& rt, jsi::Function& reject) {
    auto error = jsi::Value(rt, jsi::JSError(rt, message).value());
    if (code) {
      error.asObject(rt).setProperty(
          rt, "code", jsi::String::createFromUtf8(rt, *code));
    }
    reject.call(rt, error);
  });
}

template <typename... T>
jsi::Object Promise<T...>::get(jsi::Runtime& rt) const {
  if (auto holder = state_->promiseHolder.lock()) {
    return jsi::Value(rt, holder->promise).asObject(rt);
  }
  throw jsi::JSError(rt, "the promise was invalidated by a reload");
}

namespace detail {

template <typename T>
struct MethodTraits {
  static_assert(
      !std::is_same_v<T, T>,
      "a spec method must be a plain member function taking the spec's "
      "arguments; const and noexcept qualifiers are not supported");
};

template <typename ClassT, typename ReturnT, typename... ArgsT>
struct MethodTraits<ReturnT (ClassT::*)(ArgsT...)> {
  using Class = ClassT;
  using Return = ReturnT;
  using Args = std::tuple<ArgsT...>;
  static constexpr size_t kArity = sizeof...(ArgsT);

  template <size_t I>
  using Arg = std::tuple_element_t<I, std::tuple<ArgsT...>>;
};

template <typename Traits, size_t Offset, size_t... I>
constexpr bool argsAreNotJsi(std::index_sequence<I...>) {
  return (
      !facebook::react::bridging::is_jsi_v<
          std::decay_t<typename Traits::template Arg<Offset + I>>> &&
      ...);
}

} // namespace detail

/// The base of every generated spec class. `T` is the implementation, which
/// declares one member function per spec method and may set `kThread`.
template <typename T>
class TurboModuleBase : public facebook::react::TurboModule,
                        public std::enable_shared_from_this<T> {
 public:
  static constexpr ModuleThread kThread = ModuleThread::Own;

 protected:
  TurboModuleBase(
      std::string name,
      std::shared_ptr<facebook::react::CallInvoker> jsInvoker)
      : facebook::react::TurboModule(std::move(name), std::move(jsInvoker)) {}

  /// A method declared as `R name(jsi::Runtime&, Args...)`, run on the JS
  /// thread.
  template <auto Method>
  void valueMethod(const char* name) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    registerName<Method>(name);
    methodMap_[name] = MethodMetadata{
        .argCount = Traits::kArity - 1, .invoker = &invokeValue<Method>};
  }

  /// A method declared as `void name(Args...)`, run on `T::kThread`.
  template <auto Method>
  void voidMethod(const char* name) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    constexpr bool kOnJs = T::kThread == ModuleThread::JS;
    if constexpr (!kOnJs) {
      static_assert(
          detail::argsAreNotJsi<Traits, 0>(
              std::make_index_sequence<Traits::kArity>{}),
          "a void method that does not run on the JS thread cannot take a JSI "
          "type: convert the argument to a C++ type such as folly::dynamic");
    }
    registerName<Method>(name);
    methodMap_[name] = MethodMetadata{
        .argCount = Traits::kArity - (kOnJs ? 1 : 0),
        .invoker = &invokeVoid<Method>};
  }

  /// A method declared as `void name(Args..., rngpui::Promise<R>)`, run on
  /// `T::kThread`.
  template <auto Method>
  void promiseMethod(const char* name) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    constexpr bool kOnJs = T::kThread == ModuleThread::JS;
    if constexpr (!kOnJs) {
      static_assert(
          detail::argsAreNotJsi<Traits, 0>(
              std::make_index_sequence<Traits::kArity - 1>{}),
          "a promise method that does not run on the JS thread cannot take a "
          "JSI type: convert the argument to a C++ type such as "
          "folly::dynamic");
    }
    registerName<Method>(name);
    methodMap_[name] = MethodMetadata{
        .argCount = Traits::kArity - 1 - (kOnJs ? 1 : 0),
        .invoker = &invokePromise<Method>};
  }

  /// `V...` is the emitter's payload: `jsi::Value` for an event that carries a
  /// value, empty for one that does not.
  template <typename... V>
  void addEvent(const char* name) {
    eventEmitterMap_[name] =
        std::make_shared<facebook::react::AsyncEventEmitter<V...>>();
  }

  template <typename V>
  void emitEvent(const char* name, V value) {
    auto entry = eventEmitterMap_.find(name);
    if (entry == eventEmitterMap_.end()) {
      return;
    }
    // A hand-written module can pair a payload-less emitter with a value; a
    // mismatched cast would be undefined, so the event is dropped instead.
    auto emitter = std::dynamic_pointer_cast<
        facebook::react::AsyncEventEmitter<jsi::Value>>(entry->second);
    if (!emitter) {
      return;
    }
    emitter->emit(
        [jsInvoker = jsInvoker_,
         value = std::move(value)](jsi::Runtime& rt) -> jsi::Value {
          return facebook::react::bridging::toJs(rt, value, jsInvoker);
        });
  }

  void emitEvent(const char* name) {
    auto entry = eventEmitterMap_.find(name);
    if (entry == eventEmitterMap_.end()) {
      return;
    }
    auto emitter =
        std::dynamic_pointer_cast<facebook::react::AsyncEventEmitter<>>(
            entry->second);
    if (!emitter) {
      return;
    }
    emitter->emit();
  }

  /// For a module used through `NativeEventEmitter`.
  void sendEvent(std::string name, folly::dynamic body = nullptr) {
    emitDeviceEvent(
        name,
        [body = std::move(body)](
            jsi::Runtime& rt, std::vector<jsi::Value>& args) {
          if (!body.isNull()) {
            args.emplace_back(jsi::valueFromDynamic(rt, body));
          }
        });
  }

 private:
  /// The method name for arity errors. Every instance of `T` registers the same
  /// name, so the last write is the value every reader sees.
  template <auto Method>
  static std::atomic<const char*>& registeredName() {
    static std::atomic<const char*> name{nullptr};
    return name;
  }

  template <auto Method>
  static void registerName(const char* name) {
    registeredName<Method>().store(name, std::memory_order_relaxed);
  }

  template <auto Method>
  static std::string arityMessage(
      const facebook::react::TurboModule& base,
      size_t expected,
      size_t count) {
    const auto& self = static_cast<const TurboModuleBase<T>&>(base);
    const char* name = registeredName<Method>().load(std::memory_order_relaxed);
    return self.name_ + "." + (name != nullptr ? name : "<method>") +
        " expects " + std::to_string(expected) + " arguments, got " +
        std::to_string(count);
  }

  /// The number of JS arguments the method needs: a parameter the
  /// implementation declares as `std::optional` may be omitted, so the last
  /// required parameter decides.
  template <typename Traits, size_t Offset, size_t... I>
  static constexpr size_t requiredCount(std::index_sequence<I...>) {
    size_t required = 0;
    ((required = facebook::react::bridging::is_optional_v<
                     std::decay_t<typename Traits::template Arg<Offset + I>>>
          ? required
          : I + 1),
     ...);
    return required;
  }

  /// `jsIndex` is past the end when the spec marks the parameter optional and
  /// JS omitted it.
  template <typename Traits, size_t ArgIndex>
  static std::decay_t<typename Traits::template Arg<ArgIndex>> convertArg(
      jsi::Runtime& rt,
      const jsi::Value* args,
      size_t count,
      const std::shared_ptr<facebook::react::CallInvoker>& jsInvoker,
      size_t jsIndex) {
    using Arg = std::decay_t<typename Traits::template Arg<ArgIndex>>;
    if (jsIndex >= count) {
      if constexpr (facebook::react::bridging::is_optional_v<Arg>) {
        return Arg{};
      } else {
        // Unreachable: requiredCount() rejected the call already.
        throw jsi::JSError(rt, "a required argument is missing");
      }
    }
    return facebook::react::bridging::fromJs<Arg>(rt, args[jsIndex], jsInvoker);
  }

  /// Converts `Args[Offset..]`; the JS arguments start at `args[0]`.
  template <auto Method, typename Traits, size_t Offset, size_t... I>
  static auto convertArgs(
      jsi::Runtime& rt,
      const facebook::react::TurboModule& base,
      const jsi::Value* args,
      size_t count,
      const std::shared_ptr<facebook::react::CallInvoker>& jsInvoker,
      std::index_sequence<I...>) {
    constexpr size_t kRequired =
        requiredCount<Traits, Offset>(std::index_sequence<I...>{});
    if (count < kRequired) {
      throw jsi::JSError(rt, arityMessage<Method>(base, kRequired, count));
    }
    return std::make_tuple(
        convertArg<Traits, Offset + I>(rt, args, count, jsInvoker, I)...);
  }

  template <auto Method>
  static jsi::Value invokeValue(
      jsi::Runtime& rt,
      facebook::react::TurboModule& base,
      const jsi::Value* args,
      size_t count) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    auto& self = static_cast<T&>(base);
    auto converted = convertArgs<Method, Traits, 1>(
        rt,
        base,
        args,
        count,
        self.jsInvoker_,
        std::make_index_sequence<Traits::kArity - 1>{});
    return std::apply(
        [&](auto&&... values) -> jsi::Value {
          return facebook::react::bridging::toJs(
              rt,
              (self.*Method)(rt, std::forward<decltype(values)>(values)...),
              self.jsInvoker_);
        },
        std::move(converted));
  }

  template <auto Method>
  static jsi::Value invokeVoid(
      jsi::Runtime& rt,
      facebook::react::TurboModule& base,
      const jsi::Value* args,
      size_t count) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    constexpr bool kOnJs = T::kThread == ModuleThread::JS;
    constexpr size_t kOffset = kOnJs ? 1 : 0;
    auto& self = static_cast<T&>(base);
    auto converted = convertArgs<Method, Traits, kOffset>(
        rt,
        base,
        args,
        count,
        self.jsInvoker_,
        std::make_index_sequence<Traits::kArity - kOffset>{});
    if constexpr (kOnJs) {
      std::apply(
          [&](auto&&... values) {
            (self.*Method)(rt, std::forward<decltype(values)>(values)...);
          },
          std::move(converted));
    } else {
      auto task = [weak = std::weak_ptr<T>(self.weak_from_this()),
                   converted = std::move(converted)]() mutable {
        auto module = weak.lock();
        if (!module) {
          return;
        }
        try {
          std::apply(
              [&](auto&&... values) {
                (module.get()->*Method)(
                    std::forward<decltype(values)>(values)...);
              },
              std::move(converted));
        } catch (const std::exception& error) {
          LOG(ERROR) << module->name_ << ": " << error.what();
        }
        releaseOnJsThread(std::move(module));
      };
      self.post(std::move(task));
    }
    return jsi::Value::undefined();
  }

  template <auto Method>
  static jsi::Value invokePromise(
      jsi::Runtime& rt,
      facebook::react::TurboModule& base,
      const jsi::Value* args,
      size_t count) {
    using Traits = detail::MethodTraits<decltype(Method)>;
    using PromiseType =
        std::decay_t<typename Traits::template Arg<Traits::kArity - 1>>;
    constexpr bool kOnJs = T::kThread == ModuleThread::JS;
    constexpr size_t kOffset = kOnJs ? 1 : 0;
    auto& self = static_cast<T&>(base);
    auto converted = convertArgs<Method, Traits, kOffset>(
        rt,
        base,
        args,
        count,
        self.jsInvoker_,
        std::make_index_sequence<Traits::kArity - kOffset - 1>{});
    PromiseType promise(rt, self.jsInvoker_);
    auto task = [weak = std::weak_ptr<T>(self.weak_from_this()),
                 converted = std::move(converted),
                 promise]() mutable {
      auto module = weak.lock();
      if (!module) {
        promise.reject("the module was released before the call ran");
        return;
      }
      try {
        std::apply(
            [&](auto&&... values) {
              (module.get()->*Method)(
                  std::forward<decltype(values)>(values)..., promise);
            },
            std::move(converted));
      } catch (const std::exception& error) {
        promise.reject(error.what());
      }
      releaseOnJsThread(std::move(module));
    };
    if constexpr (kOnJs) {
      task();
    } else {
      self.post(std::move(task));
    }
    return promise.get(rt);
  }

  /// A module owns JSI state, so it has to be destroyed on the JS thread while
  /// the runtime is alive. A task that holds the last reference means the JS
  /// owner released the module while the call ran (a reload), so no JS thread
  /// can destroy it any more. The queue is stopped first, so its worker thread
  /// does not outlive the module, and the reference is then kept until the
  /// process exits: releasing it here would release JSI state from a module
  /// thread, after the runtime is gone.
  static void releaseOnJsThread(std::shared_ptr<T> module) {
    if (module.use_count() > 1) {
      return;
    }
    module->stopQueue();
    std::lock_guard<std::mutex> lock(parkedModulesMutex());
    parkedModules().push_back(std::move(module));
  }

  // Both are leaked on purpose: destroying a parked module at exit would
  // release its JSI state after the runtime is gone, which is the crash parking
  // it avoids.
  static std::mutex& parkedModulesMutex() {
    static auto* mutex = new std::mutex();
    return *mutex;
  }

  static std::vector<std::shared_ptr<T>>& parkedModules() {
    static auto* parked = new std::vector<std::shared_ptr<T>>();
    return *parked;
  }

  /// Stops this module's queue, if it has one.
  void stopQueue() {
    if (queue_) {
      queue_->stop();
    }
  }

  /// Runs `task` on `T::kThread`. JS-thread methods run inline in their
  /// invoker, so they never reach this.
  void post(std::function<void()> task) {
    if constexpr (T::kThread == ModuleThread::Main) {
      dispatchMain(std::move(task));
    } else {
      if (!queue_) {
        queue_ = std::make_unique<ModuleQueue>("rn.module." + name_);
      }
      queue_->post(std::move(task));
    }
  }

  std::unique_ptr<ModuleQueue> queue_;
};

/// Returns a new Module when `name` is the module's registered name, otherwise
/// nullptr.
template <typename Module>
std::shared_ptr<facebook::react::TurboModule> provideTurboModule(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  if (name != Module::kModuleName) {
    return nullptr;
  }
  return std::make_shared<Module>(std::move(jsInvoker));
}

} // namespace rngpui

namespace facebook::react {

/// An `ArrayBuffer` spec type is `std::vector<uint8_t>`, so a method that runs
/// off the JS thread gets bytes it owns rather than a runtime-bound object.
template <>
struct Bridging<std::vector<uint8_t>> {
  static std::vector<uint8_t> fromJs(jsi::Runtime& rt, const jsi::Object& obj) {
    if (!obj.isArrayBuffer(rt)) {
      throw jsi::JSError(rt, "expected an ArrayBuffer");
    }
    const jsi::ArrayBuffer buffer = obj.getArrayBuffer(rt);
    const uint8_t* data = buffer.data(rt);
    return std::vector<uint8_t>(data, data + buffer.size(rt));
  }

  static jsi::Value toJs(jsi::Runtime& rt, const std::vector<uint8_t>& bytes) {
    return {
        rt,
        rt.createArrayBuffer(
            std::make_shared<facebook::react::detail::OwnedBytesBuffer>(
                bytes))};
  }
};

} // namespace facebook::react
