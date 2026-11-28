cmake_minimum_required(VERSION 3.18)

set(_enriched_md_cpp "${CMAKE_CURRENT_LIST_DIR}/../cpp")
set(_enriched_md_ts "${_enriched_md_cpp}/highlight/vendor")
set(_enriched_md_codegen "${RN_GPUI_PROJECT_ROOT}/desktop/autolink/codegen/EnrichedMarkdownTextSpec")

add_library(enriched_md_md4c OBJECT
  "${_enriched_md_cpp}/md4c/md4c.c")
target_include_directories(enriched_md_md4c PRIVATE "${_enriched_md_cpp}/md4c")
target_compile_definitions(enriched_md_md4c PRIVATE MD4C_USE_UTF8=1)
set_target_properties(enriched_md_md4c PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
  POSITION_INDEPENDENT_CODE ON)

add_library(enriched_md_ts_runtime OBJECT
  "${_enriched_md_ts}/tree-sitter/src/lib.c")
target_include_directories(enriched_md_ts_runtime
  PRIVATE "${_enriched_md_ts}/tree-sitter/src"
  PUBLIC "${_enriched_md_ts}/tree-sitter/include")
set_target_properties(enriched_md_ts_runtime PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
  POSITION_INDEPENDENT_CODE ON)
if(NOT MSVC)
  target_compile_options(enriched_md_ts_runtime PRIVATE -fvisibility=hidden)
endif()

set(_enriched_md_langs
  json html css markdown yaml go java javascript python c rust bash typescript tsx)
set(_enriched_md_grammar_objs "")
foreach(_lang IN LISTS _enriched_md_langs)
  set(_gdir "${_enriched_md_ts}/grammars/${_lang}")
  set(_gsrcs "${_gdir}/parser.c")
  if(EXISTS "${_gdir}/scanner.c")
    list(APPEND _gsrcs "${_gdir}/scanner.c")
  endif()
  add_library(enriched_md_ts_grammar_${_lang} OBJECT ${_gsrcs})
  target_include_directories(enriched_md_ts_grammar_${_lang} PRIVATE "${_gdir}")
  set_target_properties(enriched_md_ts_grammar_${_lang} PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED ON
    POSITION_INDEPENDENT_CODE ON)
  if(NOT MSVC)
    target_compile_options(enriched_md_ts_grammar_${_lang} PRIVATE -fvisibility=hidden)
  endif()
  list(APPEND _enriched_md_grammar_objs "$<TARGET_OBJECTS:enriched_md_ts_grammar_${_lang}>")
endforeach()

set(_enriched_md_cxx_sources
  "${_enriched_md_cpp}/parser/MD4CParser.cpp"
  "${_enriched_md_cpp}/parser/TextLinkRecognizer.cpp"
  "${_enriched_md_cpp}/highlight/CodeBlockHighlighter.cpp"
  "${_enriched_md_cpp}/highlight/CodeBlockLanguages.cpp"
  "${_enriched_md_ts}/generated/generated_registry.cpp")

add_library(enriched_md_core OBJECT ${_enriched_md_cxx_sources})
target_include_directories(enriched_md_core PRIVATE
  "${_enriched_md_cpp}/md4c"
  "${_enriched_md_cpp}/parser"
  "${_enriched_md_cpp}/highlight"
  "${_enriched_md_ts}/tree-sitter/include"
  "${_enriched_md_ts}/generated")
target_compile_definitions(enriched_md_core PRIVATE
  MD4C_USE_UTF8=1
  ENRICHED_MARKDOWN_CODE_HIGHLIGHT=1)
set_target_properties(enriched_md_core PROPERTIES
  CXX_STANDARD 20
  CXX_STANDARD_REQUIRED ON
  POSITION_INDEPENDENT_CODE ON)

set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_SOURCES
  "$<TARGET_OBJECTS:enriched_md_md4c>"
  "$<TARGET_OBJECTS:enriched_md_ts_runtime>"
  ${_enriched_md_grammar_objs}
  "$<TARGET_OBJECTS:enriched_md_core>"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiMarkdownBridge.cpp"
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GpuiMarkdownModule.cpp")

set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INSTALLERS enriched_markdown)

set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
  "${CMAKE_CURRENT_LIST_DIR}/cpp"
  "${_enriched_md_cpp}/md4c"
  "${_enriched_md_cpp}/parser"
  "${_enriched_md_cpp}/highlight"
  "${_enriched_md_ts}/tree-sitter/include"
  "${_enriched_md_ts}/generated"
  "${_enriched_md_codegen}")

if(DEFINED RN_GPUI_PREBUILT_ROOT_boost AND EXISTS "${RN_GPUI_PREBUILT_ROOT_boost}/boost/regex.hpp")
  set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
    "${RN_GPUI_PREBUILT_ROOT_boost}")
endif()
if(DEFINED RN_GPUI_BOOST_ARCHIVE_DIR AND EXISTS "${RN_GPUI_BOOST_ARCHIVE_DIR}/boost_1_83_0/boost/regex.hpp")
  set_property(GLOBAL APPEND PROPERTY RN_GPUI_PACKAGE_MODULE_INCLUDE_DIRS
    "${RN_GPUI_BOOST_ARCHIVE_DIR}/boost_1_83_0")
endif()
