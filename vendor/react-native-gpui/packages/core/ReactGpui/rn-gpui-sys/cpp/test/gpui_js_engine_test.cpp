// Unit test for the JS engine registry and its selection rules
//.
//
// The registry is process-global and registration is startup-only, so the cases
// run in the order the rules apply: no engine, one engine, several engines with
// and without an explicit selection, and an unknown name.
#include "GpuiJsEngine.h"

#include <cstdio>
#include <stdexcept>
#include <string>

namespace {

int failures = 0;

void check(bool condition, const std::string& what) {
  if (!condition) {
    ++failures;
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
  }
}

// Runs `body` and reports whether it threw a std::exception whose message
// contains `expected`.
template <typename Body>
void checkThrows(
    Body body,
    const std::string& expected,
    const std::string& what) {
  try {
    body();
  } catch (const std::exception& error) {
    if (std::string(error.what()).find(expected) == std::string::npos) {
      ++failures;
      std::fprintf(
          stderr,
          "FAIL: %s (message %s does not contain %s)\n",
          what.c_str(),
          error.what(),
          expected.c_str());
    }
    return;
  } catch (...) {
    ++failures;
    std::fprintf(stderr, "FAIL: %s (threw the wrong type)\n", what.c_str());
    return;
  }
  ++failures;
  std::fprintf(stderr, "FAIL: %s (did not throw)\n", what.c_str());
}

rngpui::GpuiJsEngine makeEngine(const std::string& name) {
  return rngpui::GpuiJsEngine{
      .info = {.name = name, .version = "1.2.3"},
      .makeRuntimeFactory = [] { return nullptr; },
  };
}

} // namespace

int main() {
  using rngpui::activeJsEngine;
  using rngpui::registeredJsEngines;
  using rngpui::registerJsEngine;
  using rngpui::selectJsEngine;

  // No engine installed.
  check(registeredJsEngines().empty(), "no engines are registered yet");
  checkThrows(
      [] { activeJsEngine(); },
      "no JS engine installed",
      "activeJsEngine with no engine");

  // One engine: it is the default.
  registerJsEngine(makeEngine("alpha"));
  check(registeredJsEngines().size() == 1, "one engine registered");
  check(
      activeJsEngine().info.name == "alpha", "the only engine is the default");
  check(activeJsEngine().info.version == "1.2.3", "the version is reported");

  // Several engines: ambiguous until one is selected.
  registerJsEngine(makeEngine("beta"));
  check(registeredJsEngines().size() == 2, "two engines registered");
  checkThrows(
      [] { activeJsEngine(); },
      "several JS engines are installed",
      "activeJsEngine with two engines and no selection");
  checkThrows(
      [] { activeJsEngine(); },
      "alpha, beta",
      "the ambiguity message lists the registered engines");

  // Several engines with a selection.
  selectJsEngine("beta");
  check(activeJsEngine().info.name == "beta", "the selection wins");
  selectJsEngine("alpha");
  check(activeJsEngine().info.name == "alpha", "the selection can change");
  selectJsEngine("");
  checkThrows(
      [] { activeJsEngine(); },
      "several JS engines",
      "an empty selection returns to the ambiguous default");

  // Unknown name.
  checkThrows(
      [] { selectJsEngine("gamma"); },
      "unknown JS engine 'gamma'",
      "selectJsEngine with an unknown name");
  checkThrows(
      [] { selectJsEngine("gamma"); },
      "alpha, beta",
      "the unknown-name message lists the registered engines");

  // Registration is validated.
  checkThrows(
      [] { registerJsEngine(makeEngine("")); },
      "must report a name",
      "registerJsEngine with an empty name");
  checkThrows(
      [] { registerJsEngine(makeEngine("alpha")); },
      "duplicate JS engine 'alpha'",
      "registerJsEngine with a duplicate name");
  checkThrows(
      [] {
        registerJsEngine(rngpui::GpuiJsEngine{
            .info = {.name = "gamma", .version = "1"},
        });
      },
      "no runtime factory",
      "registerJsEngine without a runtime factory");

  // A failed registration must not have been recorded.
  selectJsEngine("alpha");
  check(activeJsEngine().info.name == "alpha", "the registry is unchanged");

  if (failures == 0) {
    std::printf("gpui_js_engine_test: all checks passed\n");
    return 0;
  }
  std::fprintf(stderr, "gpui_js_engine_test: %d check(s) failed\n", failures);
  return 1;
}
