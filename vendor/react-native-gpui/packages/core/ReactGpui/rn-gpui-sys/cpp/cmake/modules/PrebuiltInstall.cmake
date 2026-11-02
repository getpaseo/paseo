include(GNUInstallDirs)

set(RN_GPUI_PREBUILT_CONFIG_NAME "react-native-gpui-prebuilt")
set(_rn_gpui_prebuilt_gen "${CMAKE_BINARY_DIR}/prebuilt")

# --- classify the link closure -------------------------------------------------
# Skipped: app-side and per-app targets (rn_gpui_app_turbo_modules,
# rn_gpui_modules, rn_gpui_autolink_*).
set(_rn_gpui_built "")       # real archives/dylibs we built (names resolved)
set(_rn_gpui_imported "")    # imported archives/dylibs, names as in the closure
set(_rn_gpui_shadow "")      # OBJECT/INTERFACE names
set(_rn_gpui_order "")       # ordered entries that real/imported targets need
foreach(_rn_gpui_entry IN LISTS RN_GPUI_LINK_TARGETS)
  if(_rn_gpui_entry STREQUAL "rn_gpui_app_turbo_modules"
     OR _rn_gpui_entry STREQUAL "rn_gpui_modules"
     OR _rn_gpui_entry MATCHES "^rn_gpui_autolink_")
    continue()
  endif()
  get_target_property(_rn_gpui_type "${_rn_gpui_entry}" TYPE)
  get_target_property(_rn_gpui_aliased "${_rn_gpui_entry}" ALIASED_TARGET)
  if(_rn_gpui_aliased)
    set(_rn_gpui_real "${_rn_gpui_aliased}")
  else()
    set(_rn_gpui_real "${_rn_gpui_entry}")
  endif()
  if(_rn_gpui_type MATCHES "^(OBJECT|INTERFACE)_LIBRARY$")
    list(APPEND _rn_gpui_shadow "${_rn_gpui_entry}")
  elseif(_rn_gpui_type MATCHES "^(STATIC|SHARED)_LIBRARY$" OR _rn_gpui_type STREQUAL "UNKNOWN_LIBRARY")
    get_target_property(_rn_gpui_imported_flag "${_rn_gpui_real}" IMPORTED)
    if(_rn_gpui_imported_flag)
      list(APPEND _rn_gpui_imported "${_rn_gpui_real}")
    else()
      list(APPEND _rn_gpui_built "${_rn_gpui_real}")
    endif()
    list(APPEND _rn_gpui_order "${_rn_gpui_entry}")
  endif()
endforeach()
list(REMOVE_DUPLICATES _rn_gpui_built)
list(REMOVE_DUPLICATES _rn_gpui_imported)

install(TARGETS ${_rn_gpui_built}
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION bin)

# Imported archives (OpenSSL and the third-party libraries) are copied from the
# path configure found. An engine's own shared library is not part of the
# archive: the installed engine package ships it.
set(_rn_gpui_imported_paths "")
foreach(_rn_gpui_imp IN LISTS _rn_gpui_imported)
  get_target_property(_rn_gpui_loc "${_rn_gpui_imp}" IMPORTED_LOCATION)
  if(_rn_gpui_loc AND EXISTS "${_rn_gpui_loc}")
    list(APPEND _rn_gpui_imported_paths "${_rn_gpui_loc}")
  else()
    message(WARNING "prebuilt: imported ${_rn_gpui_imp} has no IMPORTED_LOCATION; not installed")
  endif()
endforeach()
if(_rn_gpui_imported_paths)
  install(FILES ${_rn_gpui_imported_paths} DESTINATION lib)
endif()

# --- headers --------------------------------------------------------------------
# The archive ships no headers except OpenSSL's generated tree (Configure output,
# which consumers cannot produce without Perl). Every other header tree is named
# by a root variable RN_GPUI_PREBUILT_ROOT_<name> that the consumer sets to the
# source directory it already has (node_modules/react-native, the react-native-gpui
# package, its own cxxbridge and codegen output, an installed engine package, and
# the native-deps downloads). The targets file refers to those roots, so the
# config file checks they are set before anything is included.
install(DIRECTORY "${RN_GPUI_OPENSSL_INSTALL}/include/"
  DESTINATION include/openssl-generated
  FILES_MATCHING PATTERN "*.h")

# Static include roots in search order. ReactCommonOverrides precedes ReactCommon
# so the override headers shadow the upstream ones, as the source build does.
set(_rn_gpui_include_roots
  "\${RN_GPUI_PREBUILT_ROOT_react_native_gpui}"
  "\${RN_GPUI_PREBUILT_ROOT_react_common_overrides}"
  "\${RN_GPUI_PREBUILT_ROOT_react_common}"
  "\${RN_GPUI_PREBUILT_ROOT_react_common}/jsi"
  "\${RN_GPUI_PREBUILT_ROOT_react_common}/callinvoker"
  "\${RN_GPUI_PREBUILT_ROOT_react_cxx_platform}"
  "\${RN_GPUI_PREBUILT_ROOT_generated_rncore}"
  "\${RN_GPUI_PREBUILT_ROOT_cxxbridge}"
  "\${RN_GPUI_PREBUILT_ROOT_folly}"
  "\${RN_GPUI_PREBUILT_ROOT_glog}"
  "\${RN_GPUI_PREBUILT_ROOT_fmt}"
  "\${RN_GPUI_PREBUILT_ROOT_double_conversion}"
  "\${RN_GPUI_PREBUILT_ROOT_fast_float}"
  "\${RN_GPUI_PREBUILT_ROOT_nlohmann_json}"
  "\${RN_GPUI_PREBUILT_ROOT_boost}"
  "\${RN_GPUI_PREBUILT_ROOT_curl}"
  "\${RN_GPUI_PREBUILT_ROOT_openssl_generated}")

# --- folly compile flags ----------------------------------------------------------
# The source build has no folly-config.h. folly's flags (FOLLY_NO_CONFIG,
# FOLLY_HAVE_*, ...) are PUBLIC compile *options* on folly_runtime
# (-D<name>=<value> in folly/CMakeLists.txt), so they live in
# INTERFACE_COMPILE_OPTIONS. Split them: -D entries become compile definitions,
# everything else stays a compile option. Every exported target carries them,
# so consumers compile folly headers the same way the source build does.
set(_rn_gpui_folly_defs "")
set(_rn_gpui_folly_opts "")
if(TARGET folly_runtime)
  get_target_property(_rn_gpui_folly_all folly_runtime INTERFACE_COMPILE_OPTIONS)
  if(NOT _rn_gpui_folly_all)
    set(_rn_gpui_folly_all "")
  endif()
  foreach(_rn_gpui_flag IN LISTS _rn_gpui_folly_all)
    if(_rn_gpui_flag MATCHES "^-D(.+)$")
      list(APPEND _rn_gpui_folly_defs "${CMAKE_MATCH_1}")
    else()
      list(APPEND _rn_gpui_folly_opts "${_rn_gpui_flag}")
    endif()
  endforeach()
endif()

# --- include roots from the link closure ----------------------------------------
# Source targets add their own include dirs (ReactCommon subdirectories such as
# react/renderer/graphics/platform/cxx and react/nativemodule/core). Map every dir
# that lies inside a source tree to "<root variable>/<path inside the tree>", so
# the consumer resolves it against the tree it has. Longest source prefix wins.
# Pairs are "<source dir>" "<root variable reference>".
set(_rn_gpui_include_map
  "${RN_GPUI_OVERRIDES_DIR}" "\${RN_GPUI_PREBUILT_ROOT_react_common_overrides}"
  "${REACT_COMMON_DIR}" "\${RN_GPUI_PREBUILT_ROOT_react_common}"
  "${REACT_CXX_PLATFORM_DIR}" "\${RN_GPUI_PREBUILT_ROOT_react_cxx_platform}"
  "${CMAKE_CURRENT_SOURCE_DIR}" "\${RN_GPUI_PREBUILT_ROOT_react_native_gpui}"
  "${RN_GPUI_CXXBRIDGE_INCLUDE_DIR}" "\${RN_GPUI_PREBUILT_ROOT_cxxbridge}"
  "${RN_GPUI_GENERATED_RNCORE_DIR}/jni" "\${RN_GPUI_PREBUILT_ROOT_generated_rncore}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly" "\${RN_GPUI_PREBUILT_ROOT_folly}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/glog/exported" "\${RN_GPUI_PREBUILT_ROOT_glog}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/fmt/include" "\${RN_GPUI_PREBUILT_ROOT_fmt}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/double-conversion" "\${RN_GPUI_PREBUILT_ROOT_double_conversion}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/fast_float/include" "\${RN_GPUI_PREBUILT_ROOT_fast_float}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/nlohmann_json/include" "\${RN_GPUI_PREBUILT_ROOT_nlohmann_json}"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/boost/boost_1_83_0" "\${RN_GPUI_PREBUILT_ROOT_boost}"
  "${RN_GPUI_CURL_SOURCE_DIR}/include" "\${RN_GPUI_PREBUILT_ROOT_curl}"
  "${RN_GPUI_OPENSSL_INSTALL}/include" "\${RN_GPUI_PREBUILT_ROOT_openssl_generated}")

# rn_gpui_prebuilt_include_ref(<source dir> <out var>): sets <out var> to the
# root-variable reference for <source dir> (e.g. "${RN_GPUI_PREBUILT_ROOT_boost}/x"),
# or "" when the dir is not inside any mapped source tree.
function(rn_gpui_prebuilt_include_ref dir out_var)
  # Source trees are often named with "..", e.g. REACT_COMMON_DIR is
  # ${CMAKE_CURRENT_SOURCE_DIR}/../../..; targets report normalized paths.
  # Normalize both sides so the prefix comparison can match.
  get_filename_component(dir "${dir}" ABSOLUTE)
  set(_best_len -1)
  set(_best "")
  list(LENGTH _rn_gpui_include_map _map_count)
  math(EXPR _map_last "${_map_count} - 1")
  foreach(_map_i RANGE 0 ${_map_last} 2)
    list(GET _rn_gpui_include_map ${_map_i} _prefix)
    if(NOT _prefix STREQUAL "")
      get_filename_component(_prefix "${_prefix}" ABSOLUTE)
    endif()
    math(EXPR _installed_i "${_map_i} + 1")
    list(GET _rn_gpui_include_map ${_installed_i} _installed)
    string(LENGTH "${_prefix}" _plen)
    # An unset source variable leaves an empty prefix; it must not match anything.
    if(_plen EQUAL 0 OR NOT _plen GREATER _best_len)
      continue()
    endif()
    string(LENGTH "${dir}" _dlen)
    if(dir STREQUAL _prefix)
      set(_rel "")
    else()
      if(NOT _dlen GREATER _plen)
        continue()
      endif()
      string(SUBSTRING "${dir}" 0 ${_plen} _head)
      string(SUBSTRING "${dir}" ${_plen} 1 _sep)
      if(NOT _head STREQUAL _prefix OR NOT _sep STREQUAL "/")
        continue()
      endif()
      math(EXPR _rest_at "${_plen} + 1")
      string(SUBSTRING "${dir}" ${_rest_at} -1 _rel)
    endif()
    set(_best_len ${_plen})
    if(_rel STREQUAL "")
      set(_best "${_installed}")
    else()
      set(_best "${_installed}/${_rel}")
    endif()
  endforeach()
  set(${out_var} "${_best}" PARENT_SCOPE)
endfunction()

# Walk the link closure and the shadow targets, collect every include dir they
# declare (BUILD_INTERFACE only; INSTALL_INTERFACE and unexpanded generator
# expressions are skipped), and map each one to its installed location.
set(_rn_gpui_mapped_includes "")
set(_rn_gpui_include_walk ${RN_GPUI_LINK_TARGETS} ${_rn_gpui_shadow})
list(REMOVE_DUPLICATES _rn_gpui_include_walk)
foreach(_rn_gpui_walk_name IN LISTS _rn_gpui_include_walk)
  if(NOT TARGET "${_rn_gpui_walk_name}")
    continue()
  endif()
  foreach(_rn_gpui_prop IN ITEMS INTERFACE_INCLUDE_DIRECTORIES INTERFACE_SYSTEM_INCLUDE_DIRECTORIES)
    get_target_property(_rn_gpui_dirs "${_rn_gpui_walk_name}" ${_rn_gpui_prop})
    if(NOT _rn_gpui_dirs)
      continue()
    endif()
    foreach(_rn_gpui_dir IN LISTS _rn_gpui_dirs)
      if(_rn_gpui_dir MATCHES "^\\$<BUILD_INTERFACE:(.*)>$")
        set(_rn_gpui_dir "${CMAKE_MATCH_1}")
      elseif(_rn_gpui_dir MATCHES "\\$<")
        continue()
      endif()
      rn_gpui_prebuilt_include_ref("${_rn_gpui_dir}" _rn_gpui_inst)
      if(_rn_gpui_inst)
        list(APPEND _rn_gpui_mapped_includes "${_rn_gpui_inst}")
      endif()
    endforeach()
  endforeach()
endforeach()
# Directory-level include_directories() calls (overrides, cpp/) reach targets
# only through the directory's INCLUDE_DIRECTORIES property, not their own
# INTERFACE properties. Map those too, so they stay on the consumer's path.
get_property(_rn_gpui_dir_incs DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}" PROPERTY INCLUDE_DIRECTORIES)
foreach(_rn_gpui_dir IN LISTS _rn_gpui_dir_incs)
  rn_gpui_prebuilt_include_ref("${_rn_gpui_dir}" _rn_gpui_inst)
  if(_rn_gpui_inst)
    list(APPEND _rn_gpui_mapped_includes "${_rn_gpui_inst}")
  endif()
endforeach()
list(REMOVE_DUPLICATES _rn_gpui_mapped_includes)
foreach(_rn_gpui_inc IN LISTS _rn_gpui_mapped_includes)
  list(APPEND _rn_gpui_include_roots "${_rn_gpui_inc}")
endforeach()
# Static roots first, so overrides (installed into include/react-common, which
# the mapped dirs also point at) keep their place ahead of upstream headers.
list(REMOVE_DUPLICATES _rn_gpui_include_roots)

# --- targets file ---------------------------------------------------------------
# Generated with file(GENERATE) so $<TARGET_FILE_NAME:...> resolves to the real
# archive name for this configuration. Paths use _rn_gpui_prebuilt_root, which
# the file computes from its own location, so the archive works unpacked anywhere.
set(_rn_gpui_targets_text
"# Generated by cpp/cmake/modules/PrebuiltInstall.cmake. Do not edit.
get_filename_component(_rn_gpui_prebuilt_root \"\${CMAKE_CURRENT_LIST_DIR}/..\" ABSOLUTE)
# OpenSSL's generated headers are the only headers in the archive.
set(RN_GPUI_PREBUILT_ROOT_openssl_generated \"\${_rn_gpui_prebuilt_root}/include/openssl-generated\")
set(_rn_gpui_prebuilt_include_roots \"${_rn_gpui_include_roots}\")
")

# Every archive/dylib entry in the closure gets one IMPORTED target under the
# entry's own name (CURL::libcurl stays CURL::libcurl, even though its real
# target is libcurl_static), so INTERFACE_LINK_LIBRARIES below resolves in the
# consumer. Built entries point at $<TARGET_FILE_NAME> for this configuration;
# imported entries use the file name configure resolved.
foreach(_rn_gpui_entry IN LISTS _rn_gpui_order)
  if(_rn_gpui_entry STREQUAL "rn_gpui_core")
    continue()
  endif()
  get_target_property(_rn_gpui_aliased "${_rn_gpui_entry}" ALIASED_TARGET)
  if(_rn_gpui_aliased)
    set(_rn_gpui_real "${_rn_gpui_aliased}")
  else()
    set(_rn_gpui_real "${_rn_gpui_entry}")
  endif()
  get_target_property(_rn_gpui_imported_flag "${_rn_gpui_real}" IMPORTED)
  get_target_property(_rn_gpui_real_type "${_rn_gpui_real}" TYPE)
  if(_rn_gpui_real_type STREQUAL "SHARED_LIBRARY")
    set(_rn_gpui_kind "SHARED")
  elseif(_rn_gpui_real_type STREQUAL "UNKNOWN_LIBRARY")
    set(_rn_gpui_kind "UNKNOWN")
  else()
    set(_rn_gpui_kind "STATIC")
  endif()
  if(_rn_gpui_imported_flag)
    get_target_property(_rn_gpui_loc "${_rn_gpui_real}" IMPORTED_LOCATION)
    if(NOT _rn_gpui_loc OR NOT EXISTS "${_rn_gpui_loc}")
      message(WARNING "prebuilt: imported ${_rn_gpui_real} has no IMPORTED_LOCATION; skipped")
      continue()
    endif()
    get_filename_component(_rn_gpui_base "${_rn_gpui_loc}" NAME)
    set(_rn_gpui_file "${_rn_gpui_base}")
  else()
    set(_rn_gpui_file "$<TARGET_FILE_NAME:${_rn_gpui_real}>")
  endif()
  # A built shared library links through its import library, which the install
  # rules above put in `lib/` while the DLL itself goes to `bin/`. Emitting only
  # IMPORTED_LOCATION left the consumer with nothing to link against: CMake
  # resolved the target to `jsi-NOTFOUND` and the link emitted an empty `-L`,
  # failing with "empty search path given via `-L`". Name the DLL in `bin/` and
  # the import library in `lib/`.
  #
  # Only built targets: an imported shared library is installed with
  # `install(FILES ... DESTINATION lib)` and has no import library in the
  # archive, so its single file keeps naming `lib/`.
  if(_rn_gpui_kind STREQUAL "SHARED" AND NOT _rn_gpui_imported_flag)
    string(APPEND _rn_gpui_targets_text
"add_library(${_rn_gpui_entry} ${_rn_gpui_kind} IMPORTED)
set_target_properties(${_rn_gpui_entry} PROPERTIES
  IMPORTED_LOCATION \"\${_rn_gpui_prebuilt_root}/bin/${_rn_gpui_file}\"
  IMPORTED_IMPLIB \"\${_rn_gpui_prebuilt_root}/lib/$<TARGET_LINKER_FILE_NAME:${_rn_gpui_real}>\")
")
    continue()
  endif()
  string(APPEND _rn_gpui_targets_text
"add_library(${_rn_gpui_entry} ${_rn_gpui_kind} IMPORTED)
set_target_properties(${_rn_gpui_entry} PROPERTIES
  IMPORTED_LOCATION \"\${_rn_gpui_prebuilt_root}/lib/${_rn_gpui_file}\")
")
endforeach()

# Shadow targets: INTERFACE, include roots, folly defs, and their own defs.
# They link rn_gpui_core, which already carries every archive.
foreach(_rn_gpui_shadow_name IN LISTS _rn_gpui_shadow)
  get_target_property(_rn_gpui_own_defs "${_rn_gpui_shadow_name}" INTERFACE_COMPILE_DEFINITIONS)
  if(NOT _rn_gpui_own_defs)
    set(_rn_gpui_own_defs "")
  endif()
  set(_rn_gpui_defs ${_rn_gpui_folly_defs} ${_rn_gpui_own_defs})
  list(REMOVE_DUPLICATES _rn_gpui_defs)
  string(APPEND _rn_gpui_targets_text
"add_library(${_rn_gpui_shadow_name} INTERFACE IMPORTED)
set_target_properties(${_rn_gpui_shadow_name} PROPERTIES
  INTERFACE_INCLUDE_DIRECTORIES \"\${_rn_gpui_prebuilt_include_roots}\"
  INTERFACE_COMPILE_DEFINITIONS \"${_rn_gpui_defs}\"
  INTERFACE_COMPILE_OPTIONS \"${_rn_gpui_folly_opts}\"
  INTERFACE_LINK_LIBRARIES rn_gpui_core)
")
endforeach()

# rn_gpui_core links the real archives in the closure's order, which is the
# order static archives must be resolved in.
set(_rn_gpui_core_links "")
foreach(_rn_gpui_entry IN LISTS _rn_gpui_order)
  if(NOT _rn_gpui_entry STREQUAL "rn_gpui_core")
    list(APPEND _rn_gpui_core_links "${_rn_gpui_entry}")
  endif()
endforeach()
list(REMOVE_DUPLICATES _rn_gpui_core_links)
get_target_property(_rn_gpui_core_defs rn_gpui_core INTERFACE_COMPILE_DEFINITIONS)
if(NOT _rn_gpui_core_defs)
  set(_rn_gpui_core_defs "")
endif()
set(_rn_gpui_core_all_defs ${_rn_gpui_folly_defs} ${_rn_gpui_core_defs})
list(REMOVE_DUPLICATES _rn_gpui_core_all_defs)
string(APPEND _rn_gpui_targets_text
"add_library(rn_gpui_core STATIC IMPORTED)
set_target_properties(rn_gpui_core PROPERTIES
  IMPORTED_LOCATION \"\${_rn_gpui_prebuilt_root}/lib/$<TARGET_FILE_NAME:rn_gpui_core>\"
  INTERFACE_INCLUDE_DIRECTORIES \"\${_rn_gpui_prebuilt_include_roots}\"
  INTERFACE_COMPILE_DEFINITIONS \"${_rn_gpui_core_all_defs}\"
  INTERFACE_COMPILE_OPTIONS \"${_rn_gpui_folly_opts}\"
  INTERFACE_LINK_LIBRARIES \"${_rn_gpui_core_links}\")
")

# The targets file is evaluated per configuration: `$<TARGET_FILE_NAME:...>`
# differs between Debug and Release on MSVC (`libcurl-d.lib` vs `libcurl.lib`).
# A multi-config generator (Visual Studio) therefore rejects a fixed output name
# ("Evaluation file to be written multiple times with different content"), so the
# configuration goes into the generated name there. The install step below picks
# the one that belongs to the configuration being installed and renames it back,
# so the installed layout is identical on every platform.
if(CMAKE_CONFIGURATION_TYPES)
  set(_rn_gpui_targets_suffix "-$<CONFIG>")
else()
  set(_rn_gpui_targets_suffix "")
endif()
set(_rn_gpui_targets_file
  "${_rn_gpui_prebuilt_gen}/${RN_GPUI_PREBUILT_CONFIG_NAME}-targets${_rn_gpui_targets_suffix}.cmake")
file(GENERATE OUTPUT "${_rn_gpui_targets_file}"
  CONTENT "${_rn_gpui_targets_text}")

# --- config file --------------------------------------------------------------------
# Every root the targets file can reference. The consumer must set each one to
# an existing directory before find_package; openssl_generated is set by the
# targets file itself.
set(_rn_gpui_required_roots
  react_native_gpui react_common_overrides react_common react_cxx_platform
  generated_rncore cxxbridge folly glog fmt double_conversion fast_float
  nlohmann_json boost curl)
set(_rn_gpui_root_checks "")
foreach(_rn_gpui_root IN LISTS _rn_gpui_required_roots)
  string(APPEND _rn_gpui_root_checks
"if(NOT DEFINED RN_GPUI_PREBUILT_ROOT_${_rn_gpui_root} OR NOT EXISTS \"\${RN_GPUI_PREBUILT_ROOT_${_rn_gpui_root}}\")
  message(FATAL_ERROR \"${RN_GPUI_PREBUILT_CONFIG_NAME}: RN_GPUI_PREBUILT_ROOT_${_rn_gpui_root} must be set to an existing directory\")
endif()
")
endforeach()
file(WRITE "${_rn_gpui_prebuilt_gen}/${RN_GPUI_PREBUILT_CONFIG_NAME}-config.cmake"
"# Consumer entry point: find_package(${RN_GPUI_PREBUILT_CONFIG_NAME} CONFIG REQUIRED)
# Set RN_GPUI_PREBUILT_ROOT_<name> for each name below before calling it.
${_rn_gpui_root_checks}include(\"\${CMAKE_CURRENT_LIST_DIR}/${RN_GPUI_PREBUILT_CONFIG_NAME}-targets.cmake\")
set(${RN_GPUI_PREBUILT_CONFIG_NAME}_FOUND TRUE)
")

install(FILES
  "${_rn_gpui_prebuilt_gen}/${RN_GPUI_PREBUILT_CONFIG_NAME}-config.cmake"
  DESTINATION cmake)
# `$<CONFIG>` in the source name resolves to the configuration being installed,
# and RENAME gives every platform the same installed file name.
install(FILES "${_rn_gpui_targets_file}"
  DESTINATION cmake
  RENAME "${RN_GPUI_PREBUILT_CONFIG_NAME}-targets.cmake")
