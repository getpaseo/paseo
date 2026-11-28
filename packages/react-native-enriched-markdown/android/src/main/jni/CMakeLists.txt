cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE ON)

set(LIB_LITERAL EnrichedMarkdownTextSpec)
set(LIB_TARGET_NAME react_codegen_${LIB_LITERAL})

set(LIB_ANDROID_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../..)
set(LIB_ANDROID_GENERATED_JNI_DIR ${LIB_ANDROID_DIR}/generated/jni)
set(LIB_ANDROID_GENERATED_COMPONENTS_DIR ${LIB_ANDROID_GENERATED_JNI_DIR}/react/renderer/components/${LIB_LITERAL})

# cpp/ is a symlink to packages/core/cpp in the monorepo; published tarballs
# ship real files (materialized at prepack). Use paths relative to this file —
# Android's cross-compile CMake pass cannot access absolute paths outside the
# module via symlinks or REALPATH.
set(CPP_IN_PACKAGE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp")
set(CPP_IN_MONOREPO "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../core/cpp")

if(EXISTS "${CPP_IN_PACKAGE}/md4c/md4c.c")
  set(CPP_ROOT "${CPP_IN_PACKAGE}")
elseif(EXISTS "${CPP_IN_MONOREPO}/md4c/md4c.c")
  set(CPP_ROOT "${CPP_IN_MONOREPO}")
else()
  message(FATAL_ERROR "EnrichedMarkdown C++ sources not found. Expected cpp/ or packages/core/cpp.")
endif()

set(ANDROID_CPP_DIR "${LIB_ANDROID_DIR}/src/main/cpp")

# Optional tree-sitter code highlighting. build.gradle writes this config during
# configuration (enable flag, selected languages, generated registry dir); absent
# on a bare CMake invocation, in which case highlighting stays compiled out.
set(HIGHLIGHT_CONFIG "${LIB_ANDROID_DIR}/build/generated/highlight/highlight-config.cmake")
if(EXISTS "${HIGHLIGHT_CONFIG}")
  include("${HIGHLIGHT_CONFIG}")
endif()

file(GLOB MD4C_SOURCES "${CPP_ROOT}/md4c/*.c")
file(GLOB PARSER_SOURCES "${CPP_ROOT}/parser/*.cpp")
file(GLOB HIGHLIGHT_SOURCES "${CPP_ROOT}/highlight/*.cpp")

# md4c is C code, build as separate static library with C flags
add_library(md4c_lib STATIC ${MD4C_SOURCES})
target_include_directories(md4c_lib PUBLIC ${CPP_ROOT}/md4c)
target_compile_definitions(md4c_lib PRIVATE MD4C_USE_UTF8=1)
set_target_properties(md4c_lib PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
)

file(GLOB LIB_CODEGEN_SRCS CONFIGURE_DEPENDS ${LIB_ANDROID_GENERATED_JNI_DIR}/*.cpp ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}/*.cpp)
file(GLOB LIB_CUSTOM_JNI_SRCS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/react/renderer/components/${LIB_LITERAL}/*.cpp)

add_library(
  ${LIB_TARGET_NAME}
  SHARED
  ${LIB_CODEGEN_SRCS}
  ${LIB_CUSTOM_JNI_SRCS}
  ${PARSER_SOURCES}
  ${HIGHLIGHT_SOURCES}
  ${ANDROID_CPP_DIR}/jni-adapter.cpp
)

target_include_directories(
  ${LIB_TARGET_NAME}
  PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/react/renderer/components/${LIB_LITERAL}
  ${LIB_ANDROID_GENERATED_JNI_DIR}
  ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}
  ${CPP_ROOT}/md4c
  ${CPP_ROOT}/parser
  ${CPP_ROOT}/highlight
)

target_compile_definitions(${LIB_TARGET_NAME} PRIVATE MD4C_USE_UTF8=1)

find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)
find_library(LOG_LIB log)

target_link_libraries(
  ${LIB_TARGET_NAME}
  ${LOG_LIB}
  md4c_lib
  fbjni::fbjni
  ReactAndroid::jsi
  ReactAndroid::reactnative
)

target_include_directories(
  ${CMAKE_PROJECT_NAME}
  PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_reactnative_options(${LIB_TARGET_NAME} PRIVATE)

# --- Code-block syntax highlighting (tree-sitter) ---
# CodeBlockHighlighter.cpp / CodeBlockLanguages.cpp are already in the target via
# HIGHLIGHT_SOURCES; without the define below CodeBlockHighlighter.cpp is the stub.
# When enabled we add the runtime, the generated registry, and one OBJECT lib per
# selected grammar (each isolated to its own dir so grammar parser.h files never
# collide), then define ENRICHED_MARKDOWN_CODE_HIGHLIGHT so the real seam compiles.
if(ENRICHED_MARKDOWN_CODE_HIGHLIGHT)
  set(TS_VENDOR "${CPP_ROOT}/highlight/vendor")

  add_library(tree_sitter_runtime STATIC "${TS_VENDOR}/tree-sitter/src/lib.c")
  target_include_directories(tree_sitter_runtime
    PRIVATE "${TS_VENDOR}/tree-sitter/src"
    PUBLIC "${TS_VENDOR}/tree-sitter/include")
  set_target_properties(tree_sitter_runtime PROPERTIES
    C_STANDARD 11 C_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)
  target_compile_options(tree_sitter_runtime PRIVATE -fvisibility=hidden)

  set(GRAMMAR_OBJECTS "")
  foreach(lang IN LISTS ENRICHED_MARKDOWN_HIGHLIGHT_LANGUAGES)
    set(gdir "${TS_VENDOR}/grammars/${lang}")
    set(gsrcs "${gdir}/parser.c")
    if(EXISTS "${gdir}/scanner.c")
      list(APPEND gsrcs "${gdir}/scanner.c")
    endif()
    add_library(ts_grammar_${lang} OBJECT ${gsrcs})
    target_include_directories(ts_grammar_${lang} PRIVATE "${gdir}")
    set_target_properties(ts_grammar_${lang} PROPERTIES
      C_STANDARD 11 C_STANDARD_REQUIRED ON POSITION_INDEPENDENT_CODE ON)
    target_compile_options(ts_grammar_${lang} PRIVATE -fvisibility=hidden)
    list(APPEND GRAMMAR_OBJECTS $<TARGET_OBJECTS:ts_grammar_${lang}>)
  endforeach()

  target_sources(${LIB_TARGET_NAME} PRIVATE
    "${ENRICHED_MARKDOWN_HIGHLIGHT_GENERATED_DIR}/generated_registry.cpp"
    ${GRAMMAR_OBJECTS})
  target_include_directories(${LIB_TARGET_NAME} PRIVATE
    "${TS_VENDOR}/tree-sitter/include"
    "${ENRICHED_MARKDOWN_HIGHLIGHT_GENERATED_DIR}")
  target_compile_definitions(${LIB_TARGET_NAME} PRIVATE ENRICHED_MARKDOWN_CODE_HIGHLIGHT=1)
  target_link_libraries(${LIB_TARGET_NAME} tree_sitter_runtime)
endif()
