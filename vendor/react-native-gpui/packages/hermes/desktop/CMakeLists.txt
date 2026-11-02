get_filename_component(_hermes_package_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(_hermes_package_json "${_hermes_package_root}/package.json")
if(NOT EXISTS "${_hermes_package_json}")
  message(FATAL_ERROR
    "@react-native-gpui/hermes: package.json not found at ${_hermes_package_json}")
endif()

# --- the Hermes VM ---------------------------------------------------------
#
# RN_GPUI_HERMES_SOURCE_DIR and RN_GPUI_HERMES_BIN_ROOT may be supplied as
# environment variables to point at a different facebook/hermes checkout or
# binary root; the package's own tree is the default.
if(NOT RN_GPUI_HERMES_SOURCE_DIR AND DEFINED ENV{RN_GPUI_HERMES_SOURCE_DIR})
  set(RN_GPUI_HERMES_SOURCE_DIR "$ENV{RN_GPUI_HERMES_SOURCE_DIR}")
endif()
if(NOT RN_GPUI_HERMES_SOURCE_DIR)
  set(RN_GPUI_HERMES_SOURCE_DIR "${_hermes_package_root}")
endif()
if(NOT RN_GPUI_HERMES_BIN_ROOT AND DEFINED ENV{RN_GPUI_HERMES_BIN_ROOT})
  set(RN_GPUI_HERMES_BIN_ROOT "$ENV{RN_GPUI_HERMES_BIN_ROOT}")
endif()
if(NOT RN_GPUI_HERMES_BIN_ROOT)
  set(RN_GPUI_HERMES_BIN_ROOT "${_hermes_package_root}/bin")
endif()
if(NOT EXISTS "${RN_GPUI_HERMES_SOURCE_DIR}/API/hermes/hermes.h")
  message(FATAL_ERROR
    "Hermes headers not found under ${RN_GPUI_HERMES_SOURCE_DIR}. Install "
    "@react-native-gpui/hermes or set RN_GPUI_HERMES_SOURCE_DIR to a "
    "facebook/hermes checkout.")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
    set(RN_GPUI_HERMES_PLATFORM "linux-x64")
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    set(RN_GPUI_HERMES_PLATFORM "linux-arm64")
  else()
    message(FATAL_ERROR "Unsupported Linux Hermes architecture: ${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  set(_rn_gpui_hermes_library_name "libhermesvm.so")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
  # Windows links through the hermesvm.lib import library and loads hermesvm.dll
  # at run time; the hermes-engine workflow publishes both in win32-x64 and
  # win32-arm64 flavours.
  if(CMAKE_SIZEOF_VOID_P EQUAL 8 AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(ARM64|arm64|aarch64)$")
    set(RN_GPUI_HERMES_PLATFORM "win32-arm64")
  elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(RN_GPUI_HERMES_PLATFORM "win32-x64")
  else()
    message(FATAL_ERROR "Unsupported Windows Hermes architecture: ${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  set(_rn_gpui_hermes_library_name "hermesvm.dll")
  set(_rn_gpui_hermes_import_library_name "hermesvm.lib")
elseif(APPLE AND CMAKE_OSX_ARCHITECTURES MATCHES "arm64|aarch64")
  set(RN_GPUI_HERMES_PLATFORM "darwin-arm64")
  set(_rn_gpui_hermes_library_name "libhermesvm.dylib")
elseif(APPLE AND CMAKE_OSX_ARCHITECTURES MATCHES "x86_64|AMD64")
  set(RN_GPUI_HERMES_PLATFORM "darwin-x64")
  set(_rn_gpui_hermes_library_name "libhermesvm.dylib")
elseif(APPLE AND CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  set(RN_GPUI_HERMES_PLATFORM "darwin-arm64")
  set(_rn_gpui_hermes_library_name "libhermesvm.dylib")
elseif(APPLE AND CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
  set(RN_GPUI_HERMES_PLATFORM "darwin-x64")
  set(_rn_gpui_hermes_library_name "libhermesvm.dylib")
else()
  message(FATAL_ERROR "Unsupported Hermes target: ${CMAKE_SYSTEM_NAME}/${CMAKE_SYSTEM_PROCESSOR}")
endif()

set(RN_GPUI_HERMES_PLATFORM_BIN_DIR "${RN_GPUI_HERMES_BIN_ROOT}/${RN_GPUI_HERMES_PLATFORM}")
set(RN_GPUI_HERMES_LIBRARY "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}/${_rn_gpui_hermes_library_name}")

# Hermes binaries are gitignored, so a fresh checkout has none. Fetch this
# platform's zip from the package's own release once; the script exits 0 without
# touching the network when the binaries are already installed, and offline mode
# makes it fail with the message below instead.
if(NOT EXISTS "${RN_GPUI_HERMES_LIBRARY}")
  set(_rn_gpui_fetch_script "${_hermes_package_root}/scripts/fetch-binaries.mjs")
  if(EXISTS "${_rn_gpui_fetch_script}")
    message(STATUS "Hermes binaries missing for ${RN_GPUI_HERMES_PLATFORM}; fetching them")
    execute_process(
      COMMAND node "${_rn_gpui_fetch_script}" --platform "${RN_GPUI_HERMES_PLATFORM}"
      WORKING_DIRECTORY "${_hermes_package_root}"
      RESULT_VARIABLE _rn_gpui_fetch_result
      OUTPUT_VARIABLE _rn_gpui_fetch_stdout
      ERROR_VARIABLE _rn_gpui_fetch_stderr)
    if(NOT _rn_gpui_fetch_result EQUAL 0)
      message(STATUS "fetch-binaries.mjs failed (${_rn_gpui_fetch_result}): ${_rn_gpui_fetch_stderr}")
    endif()
  else()
    message(STATUS "fetch-binaries.mjs not found at ${_rn_gpui_fetch_script}")
  endif()
endif()

if(NOT EXISTS "${RN_GPUI_HERMES_LIBRARY}")
  message(FATAL_ERROR
    "Hermes library not found at ${RN_GPUI_HERMES_LIBRARY}. The automatic "
    "download failed (${_rn_gpui_fetch_stderr}); install the artifact by hand "
    "with `node packages/hermes/scripts/fetch-binaries.mjs --from <artifact>`, "
    "or run scripts/build-hermes-<platform> against a facebook/hermes checkout.")
endif()

add_library(hermes-engine::hermesvm SHARED IMPORTED GLOBAL)
set_target_properties(hermes-engine::hermesvm PROPERTIES
  IMPORTED_LOCATION "${RN_GPUI_HERMES_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES
    "${RN_GPUI_HERMES_SOURCE_DIR}/include;${RN_GPUI_HERMES_SOURCE_DIR}/public;${RN_GPUI_HERMES_SOURCE_DIR}/API")

if(_rn_gpui_hermes_import_library_name)
  # DLL platforms link through the import library; only the DLL itself is needed
  # at run time, and the app build script stages it next to the executable.
  set(RN_GPUI_HERMES_IMPORT_LIBRARY
    "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}/${_rn_gpui_hermes_import_library_name}")
  if(NOT EXISTS "${RN_GPUI_HERMES_IMPORT_LIBRARY}")
    message(FATAL_ERROR
      "Hermes import library not found at ${RN_GPUI_HERMES_IMPORT_LIBRARY}. A "
      "win32 Hermes artifact must contain hermesvm.dll, hermesvm.lib and hermesc.exe.")
  endif()
  set_target_properties(hermes-engine::hermesvm PROPERTIES
    IMPORTED_IMPLIB "${RN_GPUI_HERMES_IMPORT_LIBRARY}")
endif()

# --- the React Native Hermes glue ------------------------------------------
#
# RN's own CMake projects, compiled from node_modules/react-native exactly as
# core used to compile them, only now declared by the engine package. Core adds
# them (add_react_common_subdir) so the targets land in its scope, then links
# them into rn_gpui_core in a source build or into the app-side
# rn_gpui_modules archive when a prebuilt core is in use. In prebuilt mode
# they are compiled against the archive's imported React Common targets, which
# carry the same include folders and defines the archive was built with. That is
# what keeps the core archive free of every engine while still letting an
# installed engine run.
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_SUBDIRECTORIES
  hermes/inspector-modern
  hermes/executor
  react/runtime/hermes)

# Core compiles these sources into rn_gpui_modules, links these targets, and
# calls the registration symbol from the generated
# rn_gpui_install_modules().
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/GpuiHermesEngine.cpp")
# The Node-API host integration and the loader. They are this engine's own
# sources now — nothing is read from react-native-node-api — and are compiled on
# every platform, including Windows: the app's executable forwards the VM's
# Node-API exports there (see `node-api-exports.txt` and
# `rn-gpui-module-build::forward_node_api_exports`), which is what the previous
# guard here was waiting for.
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/HermesNodeApiHost.cpp"
  "${CMAKE_CURRENT_LIST_DIR}/HermesNodeAddons.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_INCLUDE_DIRS
  "${RN_GPUI_HERMES_SOURCE_DIR}/API")
# React Common headers are not added here on purpose: they must reach the glue
# through the linked targets, so that the ReactCommonOverrides copy still wins
# (an upstream header first would change view-props layouts, and the archive was
# built with the overrides).
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_INCLUDE_DIRS
  "${CMAKE_CURRENT_LIST_DIR}")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_DEPS
  hermes-engine::hermesvm
  # OBJECT libraries: a dependency on the parent does not archive their objects,
  # so they are named explicitly (as core's RN_GPUI_CORE_DEPS did).
  hermes_inspector_modern
  bridgelesshermes)

# The registration symbol itself comes from autolink, which reads it from this
# package's react-native.config.js `jsEngine.register`.

# `Platform.constants.jsEngine.version`: the pinned facebook/hermes commit this
# package's VM was built from.
file(READ "${_hermes_package_json}" _hermes_package_json_contents)
string(JSON _hermes_commit GET "${_hermes_package_json_contents}" hermes commit)
set_property(GLOBAL APPEND PROPERTY RN_GPUI_JS_ENGINE_DEFINITIONS
  "RN_GPUI_HERMES_VERSION=\"${_hermes_commit}\"")

add_executable(hermes_runtime_test
  "${CMAKE_CURRENT_LIST_DIR}/test/hermes_runtime_test.cpp")
target_link_libraries(hermes_runtime_test PRIVATE hermes-engine::hermesvm jsi)
set_target_properties(hermes_runtime_test PROPERTIES
  BUILD_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}"
  INSTALL_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}")

add_library(gpui_node_api_smoke MODULE
  "${CMAKE_CURRENT_LIST_DIR}/test/node_api_smoke_addon.c")
# The addon includes the vendored NAPI headers as <node_api.h>, which is how
# upstream Hermes ships them (include/hermes/napi).
target_include_directories(gpui_node_api_smoke PRIVATE
  "${RN_GPUI_HERMES_SOURCE_DIR}/include/hermes/napi")
# On Linux and macOS the fixture is deliberately *not* linked against Hermes:
# a stock addon is a plain shared object whose napi_* symbols are undefined and
# resolve against whatever is already loaded in the process, which there is
# libhermesvm. Binding it to Hermes would hide exactly the failure mode we care
# about. macOS needs the dynamic-lookup promise for the same reason `node-gyp`
# passes it.
#
# Windows cannot express that: an import names the DLL it comes from, so an
# unlinked fixture cannot even be created (`LNK2019` on every napi_* symbol).
# Linking against the import library is also what a real Windows addon does —
# what our forwarding exists for is the *app* resolving an addon that was built
# against `node.exe` or against nothing in particular. The mechanism is
# therefore covered end to end by the e2e test, which loads a stock npm addon;
# this target covers that the fixture itself builds and loads.
set_target_properties(gpui_node_api_smoke PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "gpui_node_api_smoke"
  BUILD_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}"
  INSTALL_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}")
if(APPLE)
  target_link_options(gpui_node_api_smoke PRIVATE "-undefined" "dynamic_lookup")
elseif(WIN32)
  target_link_libraries(gpui_node_api_smoke PRIVATE hermes-engine::hermesvm)
endif()

add_executable(hermes_node_api_addon_test
  "${CMAKE_CURRENT_LIST_DIR}/test/hermes_node_api_addon_test.cpp")
target_link_libraries(hermes_node_api_addon_test PRIVATE
  hermes-engine::hermesvm jsi)
set_target_properties(hermes_node_api_addon_test PROPERTIES
  BUILD_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}"
  INSTALL_RPATH "${RN_GPUI_HERMES_PLATFORM_BIN_DIR}")
# The DLL has to sit beside the test executable: Windows has no rpath, and the
# fixture imports from it.
if(WIN32)
  add_custom_command(TARGET hermes_node_api_addon_test POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${RN_GPUI_HERMES_LIBRARY}"
      "$<TARGET_FILE_DIR:hermes_node_api_addon_test>")
endif()
add_test(NAME hermes_node_api_addon_smoke
  COMMAND $<TARGET_FILE:hermes_node_api_addon_test>
    $<TARGET_FILE:gpui_node_api_smoke>)
