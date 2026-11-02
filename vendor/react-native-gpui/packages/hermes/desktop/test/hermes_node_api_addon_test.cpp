#include <napi/hermes_napi.h>

#include <hermes/hermes.h>
#include <jsi/hermes-interfaces.h>

#include <iostream>
#include <memory>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: hermes_node_api_addon_test <addon.node>" << std::endl;
    return 2;
  }

  auto runtime = facebook::hermes::makeHermesRuntime();
  auto* hermes =
      facebook::jsi::castInterface<facebook::hermes::IHermes>(runtime.get());
  if (!hermes) {
    std::cerr << "Hermes runtime does not expose IHermes" << std::endl;
    return 1;
  }

  napi_env env = hermes_napi_create_env(hermes->getVMRuntimeUnsafe(), nullptr);
  if (!env) {
    std::cerr << "hermes_napi_create_env returned null" << std::endl;
    return 1;
  }

  napi_handle_scope scope = nullptr;
  napi_status status = napi_open_handle_scope(env, &scope);
  if (status != napi_ok) {
    std::cerr << "napi_open_handle_scope failed: " << status << std::endl;
    return 1;
  }

  napi_value exports = nullptr;
  status = hermes_napi_load_module(env, argv[1], &exports);
  if (status != napi_ok) {
    napi_value error = nullptr;
    napi_get_and_clear_last_exception(env, &error);
    std::cerr << "hermes_napi_load_module failed: " << status << std::endl;
    napi_close_handle_scope(env, scope);
    return 1;
  }

  napi_value add = nullptr;
  napi_value args[2] = {};
  napi_value result = nullptr;
  int32_t answer = 0;
  status = napi_get_named_property(env, exports, "add", &add);
  if (status == napi_ok)
    status = napi_create_int32(env, 40, &args[0]);
  if (status == napi_ok)
    status = napi_create_int32(env, 2, &args[1]);
  if (status == napi_ok) {
    status = napi_call_function(env, exports, add, 2, args, &result);
  }
  if (status == napi_ok)
    status = napi_get_value_int32(env, result, &answer);
  napi_status close_status = napi_close_handle_scope(env, scope);

  if (status != napi_ok || close_status != napi_ok || answer != 42) {
    std::cerr << "Node-API addon smoke test failed (status=" << status
              << ", scope=" << close_status << ", answer=" << answer << ")"
              << std::endl;
    return 1;
  }

  std::cout << "Node-API addon returned 40 + 2 = " << answer << std::endl;
  return 0;
}
