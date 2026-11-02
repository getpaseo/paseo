if(NOT RN_GPUI_PROJECT_ROOT)
  message(FATAL_ERROR
    "@react-native-gpui/worklets was added by the platform; RN_GPUI_PROJECT_ROOT must be set by its build.rs")
endif()
set(_gpui_app_root "${RN_GPUI_PROJECT_ROOT}")
find_program(_gpui_node node REQUIRED)
execute_process(
  COMMAND "${_gpui_node}" -e "process.stdout.write(require.resolve('react-native-worklets/package.json', {paths: [process.argv[1]]}))" "${_gpui_app_root}"
  RESULT_VARIABLE _worklets_resolve_result
  OUTPUT_VARIABLE _worklets_package_json
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _worklets_resolve_result EQUAL 0 OR NOT EXISTS "${_worklets_package_json}")
  message(FATAL_ERROR "react-native-worklets could not be resolved from ${_gpui_app_root}")
endif()
get_filename_component(_worklets_root "${_worklets_package_json}" DIRECTORY)
set(_worklets_common "${_worklets_root}/Common/cpp")
if(NOT EXISTS "${_worklets_common}/worklets/NativeModules/WorkletsModuleProxy.h")
  message(FATAL_ERROR "react-native-worklets 0.13.x was not found in ${_gpui_app_root} or any ancestor node_modules directory")
endif()

file(GLOB_RECURSE _worklets_sources CONFIGURE_DEPENDS "${_worklets_common}/worklets/*.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES
  ${_worklets_sources}
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GPUIWorkletsModule.cpp"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GPUIPlatformLogger.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS
  "${_worklets_common}"
  "${_worklets_root}")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_DEFINITIONS
  "WORKLETS_VERSION=0.13.0")
# The frame hook is how worklets see every frame; the platform compiles this
# glue only because the package is installed.
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiWorkletsFrameModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INSTALLERS worklets)
