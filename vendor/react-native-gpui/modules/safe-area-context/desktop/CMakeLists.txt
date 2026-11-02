if(NOT RN_GPUI_PROJECT_ROOT)
  message(FATAL_ERROR
    "@react-native-gpui/safe-area-context was added by the platform; RN_GPUI_PROJECT_ROOT must be set by its build.rs")
endif()
rn_gpui_find_node_module(react-native-safe-area-context _safe_area_root)
set(_safe_area_common "${_safe_area_root}/common/cpp")
set(_safe_area_shadow_node "${_safe_area_common}/react/renderer/components/safeareacontext/RNCSafeAreaViewShadowNode.cpp")
set(_safe_area_package_json "${_safe_area_root}/package.json")

if(NOT EXISTS "${_safe_area_shadow_node}" OR NOT EXISTS "${_safe_area_package_json}")
  message(FATAL_ERROR "react-native-safe-area-context 5.10.x was not found at ${_safe_area_root}")
endif()
file(READ "${_safe_area_package_json}" _safe_area_package_json_contents)
string(JSON _safe_area_version GET "${_safe_area_package_json_contents}" version)
if(NOT _safe_area_version MATCHES "^5\\.10\\.")
  message(FATAL_ERROR "@react-native-gpui/safe-area-context supports react-native-safe-area-context 5.10.x, found ${_safe_area_version}")
endif()

set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES
  "${_safe_area_shadow_node}"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GPUISafeAreaContextModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS
  "${_safe_area_common}"
  "${RN_GPUI_REACT_CXX_PLATFORM_DIR}"
  "${CMAKE_CURRENT_LIST_DIR}/cpp")
# Safe-area insets reach the mounting manager through this glue, which the
# platform compiles only because the package is installed.
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiSafeAreaModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INSTALLERS safe_area)
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/cpp"
  "${RN_GPUI_PROJECT_ROOT}/desktop/autolink/codegen/safeareacontext")
