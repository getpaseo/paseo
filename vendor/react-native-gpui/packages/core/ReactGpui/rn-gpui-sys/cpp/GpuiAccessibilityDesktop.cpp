// Accessibility settings on Windows and Linux: the same C entry points
// GpuiAccessibilityMac.mm provides, backed by SystemParametersInfo and the
// registry on Windows, and gsettings on Linux. Neither OS pushes a change to
// an application that is not a window, so a thread re-reads the settings.

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#endif

extern "C" void rn_gpui_accessibility_setting_changed(
    const char* eventName,
    bool enabled);

namespace {

#if defined(_WIN32)

bool systemParameterFlag(UINT action) {
  BOOL value = FALSE;
  return SystemParametersInfoW(action, 0, &value, 0) && value;
}

bool readReduceMotion() {
  BOOL animations = TRUE;
  if (!SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0)) {
    return false;
  }
  return !animations;
}

bool readScreenReader() {
  return systemParameterFlag(SPI_GETSCREENREADER);
}

bool readIncreaseContrast() {
  HIGHCONTRASTW contrast{};
  contrast.cbSize = sizeof(contrast);
  return SystemParametersInfoW(
             SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0) &&
      (contrast.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

bool readReduceTransparency() {
  DWORD enabled = 1;
  DWORD size = sizeof(enabled);
  const LSTATUS status = RegGetValueW(
      HKEY_CURRENT_USER,
      L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      L"EnableTransparency",
      RRF_RT_REG_DWORD,
      nullptr,
      &enabled,
      &size);
  return status == ERROR_SUCCESS && enabled == 0;
}

#else

// `gsettings get <schema> <key>` printed without the trailing newline, or an
// empty string when gsettings or the key is missing.
std::string gsettings(const char* schema, const char* key) {
  const std::string command =
      std::string("gsettings get ") + schema + " " + key + " 2>/dev/null";
  FILE* pipe = popen(command.c_str(), "r");
  if (pipe == nullptr) {
    return {};
  }
  std::string output;
  char buffer[64];
  while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
    output += buffer;
  }
  pclose(pipe);
  while (!output.empty() && (output.back() == '\n' || output.back() == ' ')) {
    output.pop_back();
  }
  return output;
}

bool readReduceMotion() {
  return gsettings("org.gnome.desktop.interface", "enable-animations") ==
      "false";
}

bool readScreenReader() {
  return gsettings(
             "org.gnome.desktop.a11y.applications", "screen-reader-enabled") ==
      "true";
}

bool readIncreaseContrast() {
  return gsettings("org.gnome.desktop.a11y.interface", "high-contrast") ==
      "true";
}

bool readReduceTransparency() {
  return false;
}

#endif

struct Observer {
  std::mutex mutex;
  std::condition_variable wake;
  std::thread thread;
  bool stopping = false;
  bool running = false;
};

Observer& observer() {
  static Observer instance;
  return instance;
}

void observe() {
  auto& state = observer();
  bool reduceMotion = readReduceMotion();
  bool screenReader = readScreenReader();
  bool increaseContrast = readIncreaseContrast();
  bool reduceTransparency = readReduceTransparency();
  const auto changed = [](const char* name, bool& last, bool now) {
    if (now != last) {
      last = now;
      rn_gpui_accessibility_setting_changed(name, now);
    }
  };
  std::unique_lock<std::mutex> lock(state.mutex);
  while (!state.stopping) {
    if (state.wake.wait_for(
            lock, std::chrono::seconds(2), [&] { return state.stopping; })) {
      break;
    }
    lock.unlock();
    changed("reduceMotionChanged", reduceMotion, readReduceMotion());
    changed("screenReaderChanged", screenReader, readScreenReader());
    changed(
        "darkerSystemColorsChanged", increaseContrast, readIncreaseContrast());
    changed(
        "reduceTransparencyChanged",
        reduceTransparency,
        readReduceTransparency());
    lock.lock();
  }
}

} // namespace

extern "C" bool rn_gpui_get_reduce_motion() {
  return readReduceMotion();
}

extern "C" bool rn_gpui_get_reduce_transparency() {
  return readReduceTransparency();
}

extern "C" bool rn_gpui_get_increase_contrast() {
  return readIncreaseContrast();
}

extern "C" bool rn_gpui_get_invert_colors() {
  return false;
}

extern "C" bool rn_gpui_get_voice_over() {
  return readScreenReader();
}

namespace {
std::atomic<void (*)(const char*, int)> announceHandler{nullptr};
} // namespace

// The application shows an announcement as a live region of its own window, so
// the screen reader reads it as it reads any other live region change.
extern "C" void rn_gpui_set_announce_handler(
    void (*handler)(const char*, int)) {
  announceHandler.store(handler);
}

extern "C" void rn_gpui_announce_accessibility(const char* text, int priority) {
  if (auto handler = announceHandler.load()) {
    handler(text, priority);
  }
}

extern "C" void rn_gpui_start_accessibility_observing() {
  auto& state = observer();
  std::lock_guard<std::mutex> lock(state.mutex);
  if (state.running) {
    return;
  }
  state.running = true;
  state.stopping = false;
  state.thread = std::thread(observe);
}

extern "C" void rn_gpui_stop_accessibility_observing() {
  auto& state = observer();
  {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.running) {
      return;
    }
    state.stopping = true;
  }
  state.wake.notify_all();
  if (state.thread.joinable()) {
    state.thread.join();
  }
  std::lock_guard<std::mutex> lock(state.mutex);
  state.running = false;
}
