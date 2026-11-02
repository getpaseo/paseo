#include "GpuiStartupSignpost.h"

#if defined(__APPLE__)
#include <os/log.h>
#include <os/signpost.h>
#endif

namespace rngpui {

#if defined(__APPLE__)
namespace {

/// One signpost log for every stage, created once.
os_log_t startupLog() {
  static os_log_t log = os_log_create("org.reactnativegpui.startup", "startup");
  return log;
}

} // namespace
#endif

void rn_gpui_startup_signpost(::rust::Str stage, std::uint64_t elapsed_ms) {
#if defined(__APPLE__)
  os_log_t log = startupLog();
  if (log == nullptr || !os_signpost_enabled(log)) {
    return;
  }
  // One id, so every stage of a launch belongs to the same interval group.
  static os_signpost_id_t id = os_signpost_id_generate(log);
  // The name must be a string literal, and the format's arguments follow it.
  // The stage goes in the format string with `%.*s`, bounded by its length, so
  // it does not have to be constant and cannot run past its own bytes.
  os_signpost_event_emit(
      log,
      id,
      "startup stage",
      "+%llu %.*s",
      elapsed_ms,
      static_cast<int>(stage.size()),
      stage.data());
#else
  (void)stage;
  (void)elapsed_ms;
#endif
}

} // namespace rngpui
