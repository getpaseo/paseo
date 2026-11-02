if(NOT RN_GPUI_PROJECT_ROOT)
  message(FATAL_ERROR
    "@react-native-gpui/reanimated was added by the platform; RN_GPUI_PROJECT_ROOT must be set by its build.rs")
endif()
set(_gpui_app_root "${RN_GPUI_PROJECT_ROOT}")
find_program(_gpui_node node REQUIRED)
execute_process(
  COMMAND "${_gpui_node}" -e "process.stdout.write(require.resolve('react-native-reanimated/package.json', {paths: [process.argv[1]]}))" "${_gpui_app_root}"
  RESULT_VARIABLE _reanimated_resolve_result
  OUTPUT_VARIABLE _reanimated_package_json
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _reanimated_resolve_result EQUAL 0 OR NOT EXISTS "${_reanimated_package_json}")
  message(FATAL_ERROR "react-native-reanimated could not be resolved from ${_gpui_app_root}")
endif()
get_filename_component(_reanimated_root "${_reanimated_package_json}" DIRECTORY)
execute_process(
  COMMAND "${_gpui_node}" -e "process.stdout.write(require.resolve('react-native/package.json', {paths: [process.argv[1]]}))" "${_gpui_app_root}"
  RESULT_VARIABLE _react_native_resolve_result
  OUTPUT_VARIABLE _react_native_package_json
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _react_native_resolve_result EQUAL 0 OR NOT EXISTS "${_react_native_package_json}")
  message(FATAL_ERROR "react-native could not be resolved from ${_gpui_app_root}")
endif()
get_filename_component(_react_native_root "${_react_native_package_json}" DIRECTORY)
execute_process(
  COMMAND "${_gpui_node}" -e "process.stdout.write(require.resolve('react-native-worklets/package.json', {paths: [process.argv[1]]}))" "${_gpui_app_root}"
  RESULT_VARIABLE _worklets_resolve_result
  OUTPUT_VARIABLE _worklets_package_json
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _worklets_resolve_result EQUAL 0 OR NOT EXISTS "${_worklets_package_json}")
  message(FATAL_ERROR "react-native-worklets could not be resolved from ${_gpui_app_root}")
endif()
get_filename_component(_worklets_root "${_worklets_package_json}" DIRECTORY)
set(_reanimated_common "${_reanimated_root}/Common/cpp")
set(_worklets_common "${_worklets_root}/Common/cpp")
if(NOT EXISTS "${_reanimated_common}/reanimated/NativeModules/ReanimatedModuleProxy.h")
  message(FATAL_ERROR "react-native-reanimated 4.7.x was not found in ${_gpui_app_root} or any ancestor node_modules directory")
endif()
execute_process(
  COMMAND "${_gpui_node}" -e "process.stdout.write(require.resolve('@react-native-gpui/worklets/package.json', {paths: [process.argv[1]]}))" "${_gpui_app_root}"
  RESULT_VARIABLE _gpui_worklets_resolve_result
  OUTPUT_VARIABLE _gpui_worklets_package_json
  OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _gpui_worklets_resolve_result EQUAL 0 OR NOT EXISTS "${_gpui_worklets_package_json}")
  message(FATAL_ERROR "@react-native-gpui/worklets could not be resolved from ${_gpui_app_root}")
endif()
get_filename_component(_gpui_worklets_root "${_gpui_worklets_package_json}" DIRECTORY)
if(NOT EXISTS "${_worklets_common}/worklets/Compat/StableApi.h")
  message(FATAL_ERROR "react-native-worklets 0.13.x is required by GPUI Reanimated")
endif()

# Match the static feature-flag definition normally supplied by Reanimated's
# CocoaPods/Gradle builds. Without this, FeatureFlags.h silently treats every
# flag as false, including defaults which change how animated props are
# committed through Fabric.
execute_process(
  COMMAND "${_gpui_node}" -e
    "const fs=require('fs'); const flags=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const app=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); Object.assign(flags, app.reanimated?.staticFeatureFlags ?? {}); if(process.platform==='darwin' && !Object.hasOwn(app.reanimated?.staticFeatureFlags ?? {}, 'IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS')) flags.IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS=true; if(process.platform==='linux' && !Object.hasOwn(app.reanimated?.staticFeatureFlags ?? {}, 'LINUX_SYNCHRONOUSLY_UPDATE_UI_PROPS')) flags.LINUX_SYNCHRONOUSLY_UPDATE_UI_PROPS=true; process.stdout.write(Object.entries(flags).map(([key,value])=>'['+key+':'+value+']').join(''));"
    "${_reanimated_root}/src/featureFlags/staticFlags.json"
    "${_gpui_app_root}/package.json"
  RESULT_VARIABLE _reanimated_flags_result
  OUTPUT_VARIABLE _reanimated_feature_flags
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT _reanimated_flags_result EQUAL 0 OR _reanimated_feature_flags STREQUAL "")
  message(FATAL_ERROR "Failed to load Reanimated static feature flags for GPUI")
endif()

execute_process(
  COMMAND "${_gpui_node}" "${_react_native_root}/scripts/generate-codegen-artifacts.js"
    --path "${_gpui_app_root}"
    --targetPlatform ios
    --outputPath "${_gpui_app_root}/desktop/build/codegen"
    --source app
  RESULT_VARIABLE _reanimated_codegen_result
)
if(NOT _reanimated_codegen_result EQUAL 0)
  message(FATAL_ERROR "React Native codegen failed while configuring GPUI Reanimated")
endif()
set(_rn_codegen "${_gpui_app_root}/desktop/build/codegen/build/generated/ios/ReactCodegen")

file(GLOB_RECURSE _reanimated_sources CONFIGURE_DEPENDS "${_reanimated_common}/reanimated/*.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES
  ${_reanimated_sources}
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GPUIReanimatedModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS
  "${_reanimated_common}"
  "${_reanimated_root}"
  "${_worklets_common}"
  "${_rn_codegen}"
  "${_gpui_worklets_root}/desktop/cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_DEFINITIONS
  "REANIMATED_VERSION=4.7.1"
  "REANIMATED_FEATURE_FLAGS=\"${_reanimated_feature_flags}\"")
