# The build script runs the pinned React Native @react-native/codegen into
# Cargo's OUT_DIR. Consume its Android component/C++ TurboModule output here;
# Android Java and JNI implementation sources are intentionally not built.

cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE on)

set(RN_GPUI_CODEGEN_JNI_DIR "${RN_GPUI_GENERATED_RNCORE_DIR}/jni")
file(GLOB react_codegen_SRCS CONFIGURE_DEPENDS
     "${RN_GPUI_CODEGEN_JNI_DIR}/react/renderer/components/FBReactNativeSpec/*.cpp")

add_library(
  react_codegen_rncore
  OBJECT
  ${react_codegen_SRCS}
)

target_include_directories(react_codegen_rncore PUBLIC
  "${RN_GPUI_CODEGEN_JNI_DIR}"
  "${RN_GPUI_CODEGEN_JNI_DIR}/react/renderer/components/FBReactNativeSpec"
  "${RN_GPUI_CODEGEN_JNI_DIR}/react/renderer/components"
)

target_link_libraries(
  react_codegen_rncore
  jsi
  # We need to link different libraries based on whether we are building rncore or not, that's necessary
  # because we want to break a circular dependency between react_codegen_rncore and reactnative
  folly_runtime glog react_debug react_nativemodule_core react_renderer_componentregistry react_renderer_core react_renderer_debug react_renderer_graphics react_renderer_imagemanager react_renderer_mapbuffer react_utils rrc_image rrc_view yoga
)

target_compile_reactnative_options(react_codegen_rncore PRIVATE)
