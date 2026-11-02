# SVG shared Fabric props/shadow-node descriptors are supplied by RN Codegen
# and react-native-svg's published common C++ shadow-node headers.
set(_svg_codegen_dir "${RN_GPUI_PROJECT_ROOT}/desktop/autolink/codegen/rnsvg")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiSvgModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INSTALLERS svg)
set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
  "${_svg_codegen_dir}")
