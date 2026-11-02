if(NOT RN_GPUI_PROJECT_ROOT)
  message(FATAL_ERROR
    "@react-native-gpui/screens was added by the platform; RN_GPUI_PROJECT_ROOT must be set by its build.rs")
endif()
rn_gpui_find_node_module(react-native-screens _screens_root)
set(_screens_common "${_screens_root}/common/cpp")
set(_screens_component_dir "${_screens_common}/react/renderer/components/rnscreens")
set(_screens_package_json "${_screens_root}/package.json")

if(NOT EXISTS "${_screens_component_dir}/RNSScreenShadowNode.cpp" OR NOT EXISTS "${_screens_package_json}")
  message(FATAL_ERROR "react-native-screens 4.28.x was not found at ${_screens_root}")
endif()

file(READ "${_screens_package_json}" _screens_package_json_contents)
string(JSON _screens_version GET "${_screens_package_json_contents}" version)
if(NOT _screens_version MATCHES "^4\\.28\\.")
  message(FATAL_ERROR "@react-native-gpui/screens supports react-native-screens 4.28.x, found ${_screens_version}")
endif()

file(GLOB _screens_common_sources CONFIGURE_DEPENDS "${_screens_component_dir}/*.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES ${_screens_common_sources})
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS "${_screens_common}")
# The mount pipeline knows nothing about screens: this glue fills the header and
# screen fields of a mount op, and the platform compiles it only because the
# package is installed.
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiScreensModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INSTALLERS screens)
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
  "${_screens_common}")
