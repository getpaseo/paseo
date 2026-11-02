// Core's half of stock Node-API addon loading: the `_requireNodeLibrary` JSI
// global, path resolution, the per-runtime cache and the error messages.
//
// The engine supplies the VM-specific half — creating a napi_env and dlopening
// the file — through the GpuiJsEngine::NodeAddons capability. Nothing here
// includes a Hermes header.
#include "GpuiNodeAddons.h"
#include "GpuiJsEngine.h"

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <climits>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace rngpui {
namespace {

constexpr const char* kAddonCacheProperty = "__rnGpuiNodeAddonCache";

/// The platform's list separator for RN_GPUI_NODE_ADDON_PATH.
#if defined(_WIN32)
constexpr char kPathListSeparator = ';';
#else
constexpr char kPathListSeparator = ':';
#endif

/// The UTF-8 value of `RN_GPUI_NODE_ADDON_PATH`, or empty when unset.
///
/// On Windows the variable is read as wide characters and converted, rather
/// than with `std::getenv`: `getenv` returns the bytes the process's ANSI code
/// page produces, which cannot represent a directory name outside that page —
/// the same problem `pathFromUtf8` solves for the strings that come from
/// JavaScript. POSIX uses `getenv` unchanged, where the bytes are the path.
std::string nodeAddonPathEnvironment() {
#if defined(_WIN32)
  const wchar_t* wide = _wgetenv(L"RN_GPUI_NODE_ADDON_PATH");
  if (wide == nullptr || *wide == L'\0')
    return {};
  const int length =
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (length <= 0)
    return {};
  // `length` includes the terminator when it is asked for with -1.
  std::string utf8(static_cast<size_t>(length - 1), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, wide, -1, utf8.data(), length, nullptr, nullptr);
  return utf8;
#else
  const char* value = std::getenv("RN_GPUI_NODE_ADDON_PATH");
  return value == nullptr ? std::string() : std::string(value);
#endif
}

/// Splits `value` on every character in `separators`, dropping empty entries.
std::vector<std::string> splitList(const char* value, const char* separators) {
  std::vector<std::string> parts;
  if (value == nullptr)
    return parts;
  std::string current;
  for (const char* cursor = value; *cursor != '\0'; ++cursor) {
    if (std::strchr(separators, *cursor) != nullptr) {
      if (!current.empty())
        parts.push_back(current);
      current.clear();
    } else {
      current.push_back(*cursor);
    }
  }
  if (!current.empty())
    parts.push_back(current);
  return parts;
}

/// The directory holding the running executable, or an empty path. A packaged
/// app keeps its addons beside the executable, which is what makes this
/// meaningful; a dev build falls through to the embedded absolute path.
std::filesystem::path executableDirectory() {
#if defined(_WIN32)
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = GetModuleFileNameW(
        nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0)
      return {};
    if (length < buffer.size()) {
      buffer.resize(length);
      return std::filesystem::path(buffer).parent_path();
    }
    // Truncated: the path is longer than the buffer, so grow and retry.
    buffer.resize(buffer.size() * 2);
  }
#elif defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  if (size == 0)
    return {};
  std::vector<char> buffer(size);
  if (_NSGetExecutablePath(buffer.data(), &size) != 0)
    return {};
  std::error_code error;
  // The path from _NSGetExecutablePath may be a symlink or contain `..`, so
  // resolve it the same way /proc/self/exe is already resolved on Linux.
  auto resolved = std::filesystem::canonical(buffer.data(), error);
  if (error)
    return std::filesystem::path(buffer.data()).parent_path();
  return resolved.parent_path();
#elif defined(__linux__)
  std::error_code error;
  auto path = std::filesystem::read_symlink("/proc/self/exe", error);
  if (error)
    return {};
  return path.parent_path();
#else
  return {};
#endif
}

bool isRegularFile(const std::filesystem::path& path) {
  std::error_code error;
  const bool result = std::filesystem::is_regular_file(path, error);
  return result && !error;
}

/// A filesystem path as UTF-8.
///
/// `path::string()` is wrong for this on Windows: it converts the native wide
/// form with the process's ANSI code page, so a path holding a character
/// outside that page comes back with `?` in it and the addon is not found (or,
/// worse, the wrong file is). Every consumer here — the JS error message, the
/// addon cache key, and the engine's `load_module` — speaks UTF-8, so convert
/// to that explicitly.
std::string pathToUtf8(const std::filesystem::path& path) {
#if defined(_WIN32)
  const std::wstring wide = path.native();
  if (wide.empty())
    return {};
  const int length = WideCharToMultiByte(
      CP_UTF8,
      0,
      wide.data(),
      static_cast<int>(wide.size()),
      nullptr,
      0,
      nullptr,
      nullptr);
  if (length <= 0)
    return {};
  std::string utf8(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      0,
      wide.data(),
      static_cast<int>(wide.size()),
      utf8.data(),
      length,
      nullptr,
      nullptr);
  return utf8;
#else
  // POSIX paths are bytes, and callers hand us UTF-8, so this is the identity.
  return path.string();
#endif
}

/// The inverse of `pathToUtf8`: a `std::filesystem::path` for a path that came
/// from JavaScript, which is UTF-8.
///
/// On Windows `std::filesystem::path(std::string)` decodes the bytes with the
/// process's ANSI code page, so a checkout under `C:\Users\José\` or any addon
/// directory with an accented character in its name produced a path that does
/// not name the file — the addon was then reported as missing, with the mangled
/// path in the message. On POSIX the bytes are the path, so this is the
/// identity, exactly as `pathToUtf8` is.
std::filesystem::path pathFromUtf8(const std::string& utf8) {
#if defined(_WIN32)
  if (utf8.empty())
    return {};
  const int length = MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      utf8.data(),
      static_cast<int>(utf8.size()),
      nullptr,
      0);
  if (length <= 0) {
    // Not valid UTF-8. Fall back to the narrow constructor rather than
    // returning nothing: a caller that passed a byte string still gets the old
    // behaviour instead of a silent miss.
    return std::filesystem::path(utf8);
  }
  std::wstring wide(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      utf8.data(),
      static_cast<int>(utf8.size()),
      wide.data(),
      length);
  return std::filesystem::path(wide);
#else
  return std::filesystem::path(utf8);
#endif
}

/// First existing regular file wins, in the order section 3.4 of the plan
/// spells out. `tried` collects every location in the same order so the error
/// message can list them.
std::filesystem::path resolveAddonPath(
    const std::string& key,
    const std::optional<std::string>& embeddedPath,
    std::vector<std::string>& tried) {
  std::vector<std::filesystem::path> candidates;
  // Every string here comes from JavaScript or from the environment, so every
  // one of them is decoded from UTF-8. `key` is a relative path with `/`
  // separators; joining it as a path keeps that meaning.
  const auto keyPath = pathFromUtf8(key);
  const std::string addonPath = nodeAddonPathEnvironment();
  for (const auto& directory : splitList(
           addonPath.c_str(), std::string(1, kPathListSeparator).c_str())) {
    candidates.emplace_back(pathFromUtf8(directory) / keyPath);
  }
  const auto exeDir = executableDirectory();
  if (!exeDir.empty()) {
    candidates.push_back(exeDir / "node-addons" / keyPath);
#if defined(__APPLE__)
    // A macOS .app bundle keeps resources beside the executable, inside
    // Contents/Resources rather than next to the Mach-O in Contents/MacOS.
    candidates.push_back(exeDir / ".." / "Resources" / "node-addons" / keyPath);
#endif
  }
  if (embeddedPath.has_value()) {
    candidates.emplace_back(pathFromUtf8(*embeddedPath));
  }
  for (const auto& candidate : candidates) {
    tried.push_back(pathToUtf8(candidate));
    if (isRegularFile(candidate)) {
      std::error_code error;
      // The cache is keyed by the real path, so two keys that resolve to one
      // file (a symlinked package, say) share one load.
      auto canonical = std::filesystem::canonical(candidate, error);
      return error ? candidate : canonical;
    }
  }
  return {};
}

std::string missingAddonMessage(
    const std::string& key,
    const std::vector<std::string>& tried) {
  std::string message = "Cannot find Node-API addon '" + key + "'. Looked in:";
  for (const auto& location : tried) {
    message += "\n  " + location;
  }
  return message;
}

/// Where a failed call leaves its message and code for the JS wrapper to throw.
constexpr const char* kAddonFailureProperty = "__rnGpuiNodeAddonFailure";

/// Records a failure for `_requireNodeLibrary` to turn into a thrown `Error`.
///
/// The error deliberately is *not* thrown from here. A C++ `jsi::JSError`
/// thrown out of a host function does not reach JS intact: the runtime fails to
/// match it as a `JSError` and re-wraps it through its generic `std::exception`
/// path, which prefixes the message with "Exception in HostFunction" and
/// discards every property except the message string — `code` included. Leaving
/// the message and code on a global, and letting the JavaScript wrapper below
/// throw, keeps both and drops the prefix.
void setFailure(
    facebook::jsi::Runtime& rt,
    const std::string& message,
    const char* code) {
  auto failure = facebook::jsi::Object(rt);
  failure.setProperty(
      rt, "message", facebook::jsi::String::createFromUtf8(rt, message));
  if (code != nullptr) {
    failure.setProperty(
        rt, "code", facebook::jsi::String::createFromUtf8(rt, code));
  }
  rt.global().setProperty(rt, kAddonFailureProperty, std::move(failure));
}

/// The cache of already-loaded exports, stored on the runtime's global object
/// so it lives exactly as long as the runtime — a reload gets a fresh one.
facebook::jsi::Object addonCache(facebook::jsi::Runtime& rt) {
  auto global = rt.global();
  auto existing = global.getProperty(rt, kAddonCacheProperty);
  if (existing.isObject()) {
    return existing.asObject(rt);
  }
  auto cache = facebook::jsi::Object(rt);
  global.setProperty(rt, kAddonCacheProperty, cache);
  return cache;
}

} // namespace

void installNodeAddons(
    facebook::jsi::Runtime& rt,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  const auto& engine = activeJsEngine();

  // The loader is built once per runtime, from the engine's capability. When
  // the engine has none, the global still exists and fails with a message
  // naming the engine, so app code does not have to feature-detect.
  std::shared_ptr<std::function<facebook::jsi::Value(
      facebook::jsi::Runtime&, const std::string&)>>
      loader;
  if (engine.nodeAddons) {
    loader = std::make_shared<std::function<facebook::jsi::Value(
        facebook::jsi::Runtime&, const std::string&)>>(
        engine.nodeAddons->makeLoader(std::move(jsInvoker)));
  }
  const std::string unsupportedMessage =
      "Node addons are not supported by the " + engine.info.name + " JS engine";

  auto requireNodeLibrary = facebook::jsi::Function::createFromHostFunction(
      rt,
      facebook::jsi::PropNameID::forAscii(rt, "_requireNodeLibraryNative"),
      2,
      [loader, unsupportedMessage](
          facebook::jsi::Runtime& rt,
          const facebook::jsi::Value&,
          const facebook::jsi::Value* args,
          size_t count) -> facebook::jsi::Value {
        if (count < 1 || !args[0].isString()) {
          setFailure(
              rt,
              "_requireNodeLibrary expects a key string as its first "
              "argument",
              "ERR_INVALID_ARG_TYPE");
          return facebook::jsi::Value::undefined();
        }
        const std::string key = args[0].asString(rt).utf8(rt);

        std::optional<std::string> embeddedPath;
        if (count >= 2 && !args[1].isUndefined() && !args[1].isNull()) {
          if (!args[1].isString()) {
            setFailure(
                rt,
                "_requireNodeLibrary expects its second argument, when "
                "present, to be a path string",
                "ERR_INVALID_ARG_TYPE");
            return facebook::jsi::Value::undefined();
          }
          embeddedPath = args[1].asString(rt).utf8(rt);
        }

        std::vector<std::string> tried;
        const auto resolved = resolveAddonPath(key, embeddedPath, tried);
        if (resolved.empty()) {
          setFailure(rt, missingAddonMessage(key, tried), "MODULE_NOT_FOUND");
          return facebook::jsi::Value::undefined();
        }
        const std::string resolvedPath = pathToUtf8(resolved);

        auto cache = addonCache(rt);
        // Prefixed so a path can never collide with an Object.prototype name
        // such as "__proto__".
        const std::string cacheKey = "addon:" + resolvedPath;
        auto cached = cache.getProperty(rt, cacheKey.c_str());
        if (!cached.isUndefined()) {
          return cached;
        }

        if (!loader) {
          setFailure(rt, unsupportedMessage, "ERR_NODE_ADDONS_UNSUPPORTED");
          return facebook::jsi::Value::undefined();
        }
        bool loadFailed = false;
        auto exports = facebook::jsi::Value::undefined();
        try {
          exports = (*loader)(rt, resolvedPath);
        } catch (const facebook::jsi::JSError& error) {
          // A failed load is reported the same way as a failed resolution: the
          // engine's message (which carries `dlerror()`'s text, naming the
          // missing symbol) is left for the JS wrapper to throw. Letting this
          // exception cross the host-function boundary instead would prefix it
          // with "Exception in HostFunction".
          loadFailed = true;
          setFailure(rt, error.getMessage(), "ERR_DLOPEN_FAILED");
        }
        if (loadFailed) {
          return facebook::jsi::Value::undefined();
        }
        cache.setProperty(rt, cacheKey.c_str(), exports);
        return exports;
      });

  // The JS-visible loader. It calls the native function and throws a genuine
  // JavaScript `Error` when that recorded a failure, so the `code` property and
  // the multi-line message reach the caller unchanged. See `setFailure`.
  const std::string failureProperty = kAddonFailureProperty;
  const std::string wrapperSource =
      "(function (native) {\n"
      "  return function _requireNodeLibrary(key, path) {\n"
      "    const result = native(key, path);\n"
      "    const failure = globalThis." +
      failureProperty +
      ";\n"
      "    if (failure) {\n"
      "      delete globalThis." +
      failureProperty +
      ";\n"
      "      const error = new Error(failure.message);\n"
      "      if (failure.code) error.code = failure.code;\n"
      "      throw error;\n"
      "    }\n"
      "    return result;\n"
      "  };\n"
      "})\n";
  auto wrapper = rt.evaluateJavaScript(
      std::make_unique<facebook::jsi::StringBuffer>(wrapperSource),
      "node-addons.js");
  // `Function` has no call operator; the runtime does the call.
  auto requireNodeLibraryWithErrors =
      wrapper.getObject(rt).getFunction(rt).call(
          rt, std::move(requireNodeLibrary));

  rt.global().setProperty(
      rt, "_requireNodeLibrary", std::move(requireNodeLibraryWithErrors));
}

} // namespace rngpui
