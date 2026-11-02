set(RN_GPUI_NATIVE_DEPS_CACHE "${CMAKE_BINARY_DIR}/native-deps")
set(RN_GPUI_NATIVE_DEPS_DOWNLOADS "${RN_GPUI_NATIVE_DEPS_CACHE}/downloads")
set(RN_GPUI_NATIVE_DEPS_SOURCES "${RN_GPUI_NATIVE_DEPS_CACHE}/sources")
set(RN_GPUI_NATIVE_DEPS_PREPARED "${RN_GPUI_NATIVE_DEPS_CACHE}/third-party-ndk")
file(MAKE_DIRECTORY "${RN_GPUI_NATIVE_DEPS_DOWNLOADS}" "${RN_GPUI_NATIVE_DEPS_SOURCES}")

function(rn_gpui_download_extract name archive_name url out_source)
  set(_archive "${RN_GPUI_NATIVE_DEPS_DOWNLOADS}/${archive_name}")
  set(_source "${RN_GPUI_NATIVE_DEPS_SOURCES}/${name}")
  if(NOT EXISTS "${_archive}")
    message(STATUS "Downloading ${archive_name} into ${RN_GPUI_NATIVE_DEPS_DOWNLOADS}")
    set(_download_succeeded FALSE)
    foreach(_attempt RANGE 1 5)
      set(_partial_archive "${_archive}.part")
      file(REMOVE "${_partial_archive}")
      # No overall TIMEOUT: Boost is 145 MB, and a cap on the whole transfer
      # fails every attempt on a slow link however steadily it downloads.
      file(DOWNLOAD "${url}" "${_partial_archive}" SHOW_PROGRESS TLS_VERIFY ON
        INACTIVITY_TIMEOUT 45 STATUS _download_status)
      list(GET _download_status 0 _download_code)
      if(_download_code EQUAL 0)
        file(RENAME "${_partial_archive}" "${_archive}")
        set(_download_succeeded TRUE)
        break()
      endif()
      list(GET _download_status 1 _download_message)
      file(REMOVE "${_partial_archive}")
      if(_attempt LESS 5)
        math(EXPR _retry_delay "${_attempt} * 2")
        message(STATUS "Download attempt ${_attempt}/5 failed (${_download_message}); retrying in ${_retry_delay}s")
        execute_process(COMMAND "${CMAKE_COMMAND}" -E sleep "${_retry_delay}")
      endif()
    endforeach()
    if(NOT _download_succeeded)
      message(FATAL_ERROR "Failed to download ${url} after 5 attempts: ${_download_message}")
    endif()
  endif()
  if(NOT EXISTS "${_source}/.extracted")
    file(REMOVE_RECURSE "${_source}")
    file(MAKE_DIRECTORY "${_source}")
    file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_source}")
    file(WRITE "${_source}/.extracted" "${url}\n")
  endif()
  set(${out_source} "${_source}" PARENT_SCOPE)
endfunction()

# Keep these versions and source URLs aligned with node_modules/react-native/
# gradle/libs.versions.toml and ReactAndroid/build.gradle.kts.
rn_gpui_download_extract(boost "boost_1_83_0.tar.gz"
  "https://archives.boost.io/release/1.83.0/source/boost_1_83_0.tar.gz" RN_GPUI_BOOST_ARCHIVE_DIR)
rn_gpui_download_extract(double-conversion "double-conversion-1.1.6.tar.gz"
  "https://github.com/google/double-conversion/archive/v1.1.6.tar.gz" RN_GPUI_DOUBLE_CONVERSION_ARCHIVE_DIR)
rn_gpui_download_extract(fast_float "fast_float-8.0.0.tar.gz"
  "https://github.com/fastfloat/fast_float/archive/v8.0.0.tar.gz" RN_GPUI_FAST_FLOAT_ARCHIVE_DIR)
rn_gpui_download_extract(fmt "fmt-12.1.0.tar.gz"
  "https://github.com/fmtlib/fmt/archive/12.1.0.tar.gz" RN_GPUI_FMT_ARCHIVE_DIR)
rn_gpui_download_extract(folly "folly-2024.11.18.00.tar.gz"
  "https://github.com/facebook/folly/archive/v2024.11.18.00.tar.gz" RN_GPUI_FOLLY_ARCHIVE_DIR)
rn_gpui_download_extract(glog "glog-0.3.5.tar.gz"
  "https://github.com/google/glog/archive/v0.3.5.tar.gz" RN_GPUI_GLOG_ARCHIVE_DIR)
rn_gpui_download_extract(nlohmann_json "json-3.11.2.tar.gz"
  "https://github.com/nlohmann/json/archive/v3.11.2.tar.gz" RN_GPUI_NLOHMANN_JSON_ARCHIVE_DIR)
rn_gpui_download_extract(openssl "openssl-3.3.2.tar.gz"
  "https://www.openssl.org/source/openssl-3.3.2.tar.gz" RN_GPUI_OPENSSL_ARCHIVE_DIR)
rn_gpui_download_extract(curl "curl-8.11.1.tar.gz"
  "https://curl.se/download/curl-8.11.1.tar.gz" RN_GPUI_CURL_ARCHIVE_DIR)

# OpenSSL's upstream project uses Configure + Make rather than CMake. Build a
# static copy into the same per-target cache before CMake discovers it; this
# keeps CURL and ReactCxxPlatform off host OpenSSL installations.
file(GLOB _openssl_roots LIST_DIRECTORIES TRUE "${RN_GPUI_OPENSSL_ARCHIVE_DIR}/openssl-3.3.2*")
list(GET _openssl_roots 0 RN_GPUI_OPENSSL_SOURCE_DIR)
set(RN_GPUI_OPENSSL_INSTALL "${RN_GPUI_NATIVE_DEPS_CACHE}/install/openssl")
if(WIN32)
  set(_openssl_crypto_library "${RN_GPUI_OPENSSL_INSTALL}/lib/libcrypto.lib")
else()
  set(_openssl_crypto_library "${RN_GPUI_OPENSSL_INSTALL}/lib/libcrypto.a")
endif()
# Prebuilt mode: the archive carries OpenSSL's libraries and generated headers,
# so only download and extract here (the blocks below are source-mode only).
if(NOT RN_GPUI_PREBUILT_DIR AND NOT EXISTS "${_openssl_crypto_library}")
  # OpenSSL's Configure needs a native Windows Perl. Git for Windows ships an
  # MSYS Perl without Locale::Maketext::Simple and puts it ahead on PATH in Git
  # Bash, so look in Strawberry Perl's default location first and check the
  # module before Configure fails with a far less readable error.
  find_program(RN_GPUI_PERL_EXECUTABLE perl
    HINTS "C:/Strawberry/perl/bin" REQUIRED)
  if(WIN32)
    execute_process(
      COMMAND "${RN_GPUI_PERL_EXECUTABLE}" -MLocale::Maketext::Simple -e 1
      RESULT_VARIABLE _rn_gpui_perl_check
      OUTPUT_QUIET ERROR_QUIET)
    if(NOT _rn_gpui_perl_check EQUAL 0)
      message(FATAL_ERROR
        "${RN_GPUI_PERL_EXECUTABLE} cannot build OpenSSL (it lacks "
        "Locale::Maketext::Simple; Git for Windows' Perl does). Install Strawberry "
        "Perl, put it ahead of Git on PATH, or pass -DRN_GPUI_PERL_EXECUTABLE=<perl.exe>.")
    endif()
    find_program(RN_GPUI_MAKE_EXECUTABLE nmake REQUIRED)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
      set(_openssl_target VC-WIN64A)
    elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|arm64|aarch64")
      set(_openssl_target VC-WIN64-ARM)
    else()
      message(FATAL_ERROR "No OpenSSL source-build target for Windows/${CMAKE_SYSTEM_PROCESSOR}")
    endif()
  else()
    find_program(RN_GPUI_MAKE_EXECUTABLE make REQUIRED)
  endif()
  if(WIN32)
    # The VS developer environment must be active so OpenSSL uses the same
    # MSVC toolchain/runtime as React Native and the GPUI host.
  elseif(APPLE AND CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
    set(_openssl_target darwin64-arm64-cc)
  elseif(APPLE)
    set(_openssl_target darwin64-x86_64-cc)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
    set(_openssl_target linux-x86_64)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    set(_openssl_target linux-aarch64)
  else()
    message(FATAL_ERROR "No OpenSSL source-build target for ${CMAKE_SYSTEM_NAME}/${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  # no-apps: GPUI links only libssl and libcrypto; the openssl CLI in apps/
  # is not needed. The Xcode toolchain cc has no default sysroot, so
  # <inttypes.h> is missing from every OpenSSL compile unless SDKROOT names
  # the SDK; OpenSSL's Makefile does not pass -isysroot itself.
  set(_openssl_env ${CMAKE_COMMAND} -E env)
  if(APPLE)
    execute_process(COMMAND xcrun --sdk macosx --show-sdk-path
      OUTPUT_VARIABLE _openssl_sdk OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE _openssl_sdk_status)
    if(NOT _openssl_sdk_status EQUAL 0 OR _openssl_sdk STREQUAL "")
      message(FATAL_ERROR "xcrun could not locate the macOS SDK for OpenSSL")
    endif()
    set(_openssl_env ${CMAKE_COMMAND} -E env "SDKROOT=${_openssl_sdk}")
  endif()
  execute_process(
    COMMAND ${_openssl_env} "${RN_GPUI_PERL_EXECUTABLE}" ./Configure "${_openssl_target}" no-shared no-tests no-apps
    "--prefix=${RN_GPUI_OPENSSL_INSTALL}" --libdir=lib
    WORKING_DIRECTORY "${RN_GPUI_OPENSSL_SOURCE_DIR}"
    RESULT_VARIABLE _openssl_configure_status)
  if(NOT _openssl_configure_status EQUAL 0)
    message(FATAL_ERROR "OpenSSL Configure failed for ${_openssl_target}")
  endif()
  if(WIN32)
    execute_process(
      COMMAND "${RN_GPUI_MAKE_EXECUTABLE}" build_libs
      WORKING_DIRECTORY "${RN_GPUI_OPENSSL_SOURCE_DIR}"
      RESULT_VARIABLE _openssl_build_status)
  else()
    execute_process(
      COMMAND ${_openssl_env} "${RN_GPUI_MAKE_EXECUTABLE}" -j2 build_libs
      WORKING_DIRECTORY "${RN_GPUI_OPENSSL_SOURCE_DIR}"
      RESULT_VARIABLE _openssl_build_status)
  endif()
  if(NOT _openssl_build_status EQUAL 0)
    message(FATAL_ERROR "Building cached OpenSSL source failed")
  endif()
  execute_process(
    COMMAND ${_openssl_env} "${RN_GPUI_MAKE_EXECUTABLE}" install_dev
    WORKING_DIRECTORY "${RN_GPUI_OPENSSL_SOURCE_DIR}"
    RESULT_VARIABLE _openssl_install_status)
  if(NOT _openssl_install_status EQUAL 0)
    message(FATAL_ERROR "Installing cached OpenSSL into the CMake build cache failed")
  endif()
endif()
list(PREPEND CMAKE_PREFIX_PATH "${RN_GPUI_OPENSSL_INSTALL}")
set(OPENSSL_ROOT_DIR "${RN_GPUI_OPENSSL_INSTALL}" CACHE PATH "GPUI build-cache OpenSSL" FORCE)
set(OPENSSL_USE_STATIC_LIBS TRUE)

file(GLOB _curl_roots LIST_DIRECTORIES TRUE "${RN_GPUI_CURL_ARCHIVE_DIR}/curl-8.11.1*")
list(GET _curl_roots 0 RN_GPUI_CURL_SOURCE_DIR)

file(MAKE_DIRECTORY "${RN_GPUI_NATIVE_DEPS_PREPARED}")
set(RN_GPUI_NATIVE_DEPS_BUILD "${RN_GPUI_NATIVE_DEPS_CACHE}/build")
file(MAKE_DIRECTORY "${RN_GPUI_NATIVE_DEPS_BUILD}")

# ReactAndroid's Gradle prepare tasks strip unused files and retain only what
# its CMake dependency targets compile. Use the same CMake recipes from RN.
set(_rn_third_party "${REACT_ANDROID_SOURCE_DIR}/src/main/jni/third-party")

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/boost")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _boost_root LIST_DIRECTORIES TRUE "${RN_GPUI_BOOST_ARCHIVE_DIR}/boost_1_83_0*")
list(GET _boost_root 0 _boost_root)
file(COPY "${_boost_root}/boost" DESTINATION "${_dst}/boost_1_83_0")

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/double-conversion")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _double_root LIST_DIRECTORIES TRUE "${RN_GPUI_DOUBLE_CONVERSION_ARCHIVE_DIR}/double-conversion-1.1.6*")
list(GET _double_root 0 _double_root)
file(COPY "${_double_root}/src/" DESTINATION "${_dst}/double-conversion")
configure_file("${_rn_third_party}/double-conversion/CMakeLists.txt" "${_dst}/CMakeLists.txt" COPYONLY)
# double-conversion 1.1.6 predates MSVC ARM64 and stops on `#error` there; ARM64
# has correct double operations, as the `__aarch64__` branch already says.
set(_double_utils "${_dst}/double-conversion/utils.h")
file(READ "${_double_utils}" _double_utils_text)
string(REPLACE "#if defined(_M_X64) || defined(__x86_64__)"
  "#if defined(_M_X64) || defined(_M_ARM64) || defined(__x86_64__)"
  _double_utils_patched "${_double_utils_text}")
if(_double_utils_patched STREQUAL _double_utils_text)
  message(FATAL_ERROR "double-conversion changed ${_double_utils}; update the ARM64 check")
endif()
file(WRITE "${_double_utils}" "${_double_utils_patched}")

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/fast_float")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _fast_float_root LIST_DIRECTORIES TRUE "${RN_GPUI_FAST_FLOAT_ARCHIVE_DIR}/fast_float-8.0.0*")
list(GET _fast_float_root 0 _fast_float_root)
file(COPY "${_fast_float_root}/include" DESTINATION "${_dst}")
configure_file("${_rn_third_party}/fast_float/CMakeLists.txt" "${_dst}/CMakeLists.txt" COPYONLY)

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/fmt")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _fmt_root LIST_DIRECTORIES TRUE "${RN_GPUI_FMT_ARCHIVE_DIR}/fmt-12.1.0*")
list(GET _fmt_root 0 _fmt_root)
file(COPY "${_fmt_root}/src" "${_fmt_root}/include" DESTINATION "${_dst}")
configure_file("${_rn_third_party}/fmt/CMakeLists.txt" "${_dst}/CMakeLists.txt" COPYONLY)

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _folly_root LIST_DIRECTORIES TRUE "${RN_GPUI_FOLLY_ARCHIVE_DIR}/folly-2024.11.18.00*")
list(GET _folly_root 0 _folly_root)
file(COPY "${_folly_root}/folly" DESTINATION "${_dst}")
file(READ "${_rn_third_party}/folly/CMakeLists.txt" _folly_cmake)
# ReactAndroid targets libc++; GPUI uses the host C++ standard library.
string(REPLACE "        -DFOLLY_USE_LIBCPP=1\n" "" _folly_cmake "${_folly_cmake}")
if(WIN32)
  # The rest of ReactAndroid's folly flags describe a POSIX/Android host:
  # MSVC has no pthreads, recvmmsg, XSI strerror_r or clock_gettime, and folly
  # selects its Windows implementations when those are not defined.
  foreach(_folly_flag IN ITEMS
      "-DFOLLY_HAVE_PTHREAD=1"
      "-DFOLLY_HAVE_RECVMMSG=1"
      "-DFOLLY_HAVE_XSI_STRERROR_R=1"
      "-DFOLLY_HAVE_CLOCK_GETTIME=1"
      "-DFOLLY_MOBILE=1")
    string(REPLACE "${_folly_flag}\n" "\n" _folly_cmake "${_folly_cmake}")
  endforeach()
endif()
file(WRITE "${_dst}/CMakeLists.txt" "${_folly_cmake}")

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/glog")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}/glog-0.3.5" "${_dst}/exported/glog")
file(GLOB _glog_root LIST_DIRECTORIES TRUE "${RN_GPUI_GLOG_ARCHIVE_DIR}/glog-0.3.5*")
list(GET _glog_root 0 _glog_root)
file(COPY "${_glog_root}/src" DESTINATION "${_dst}/glog-0.3.5")
configure_file("${_rn_third_party}/glog/CMakeLists.txt" "${_dst}/CMakeLists.txt" COPYONLY)
configure_file("${_rn_third_party}/glog/config.h" "${_dst}/config.h" COPYONLY)
file(GLOB_RECURSE _glog_templates "${_dst}/glog-0.3.5/src/*.h.in")
set(_glog_token_names
  ac_cv_have_unistd_h ac_cv_have_stdint_h ac_cv_have_systypes_h ac_cv_have_inttypes_h
  ac_cv_have_libgflags ac_google_start_namespace ac_cv_have_uint16_t ac_cv_have_u_int16_t
  ac_cv_have___uint16 ac_google_end_namespace ac_cv_have___builtin_expect ac_google_namespace
  ac_cv___attribute___noinline ac_cv___attribute___noreturn ac_cv___attribute___printf_4_5
  ac_cv_cxx_using_operator)
if(WIN32)
  # MSVC has no <unistd.h>, no __builtin_expect and no GNU __attribute__. The
  # attribute tokens are commented out rather than emptied: CMake lists cannot
  # carry empty elements reliably, and a comment keeps the declarations valid.
  set(_glog_have_unistd_h 0)
  set(_glog_have_builtin_expect 0)
  set(_glog_attribute_noinline "/* noinline */")
  set(_glog_attribute_noreturn "/* noreturn */")
  set(_glog_attribute_printf "/* printf format attribute */")
else()
  set(_glog_have_unistd_h 1)
  set(_glog_have_builtin_expect 1)
  set(_glog_attribute_noinline "__attribute__ ((noinline))")
  set(_glog_attribute_noreturn "__attribute__ ((noreturn))")
  set(_glog_attribute_printf "__attribute__((__format__ (__printf__, 4, 5)))")
endif()
set(_glog_token_values
  ${_glog_have_unistd_h} 1 1 1 0 "namespace google {" 1 1 0 "}" ${_glog_have_builtin_expect} google
  "${_glog_attribute_noinline}" "${_glog_attribute_noreturn}"
  "${_glog_attribute_printf}" 1)
foreach(_template IN LISTS _glog_templates)
  file(READ "${_template}" _glog_content)
  list(LENGTH _glog_token_names _glog_token_count)
  math(EXPR _glog_token_last "${_glog_token_count} - 1")
  foreach(_index RANGE 0 ${_glog_token_last})
    list(GET _glog_token_names ${_index} _token_name)
    list(GET _glog_token_values ${_index} _token_value)
    string(REPLACE "@${_token_name}@" "${_token_value}" _glog_content "${_glog_content}")
  endforeach()
  string(REGEX REPLACE "\\.h\\.in$" ".h" _generated_header "${_template}")
  file(WRITE "${_generated_header}" "${_glog_content}")
endforeach()
# config.h.in is an Autoconf template with #undef directives, not @name@
# substitutions. ReactAndroid ships the configured platform header separately;
# place it at both include locations because glog's sources search src/ first.
if(WIN32)
  # ReactAndroid's config.h is generated for Android/Linux and describes
  # headers and builtins MSVC does not have, so Windows gets its own.
  configure_file("${CMAKE_CURRENT_LIST_DIR}/glog-windows-config.h"
    "${_dst}/glog-0.3.5/src/config.h" COPYONLY)
  configure_file("${CMAKE_CURRENT_LIST_DIR}/glog-windows-config.h"
    "${_dst}/config.h" COPYONLY)
  # <windows.h> defines an ERROR macro, and glog refuses to compile when it is
  # set. glog's escape hatch (GLOG_NO_ABBREVIATED_SEVERITIES) would force every
  # ReactCommon call site onto the GLOG_ERROR spelling, so drop the macro
  # instead of the severities.
  file(GLOB_RECURSE _glog_severity_headers "${_dst}/glog-0.3.5/src/*log_severity.h")
  foreach(_glog_severity IN LISTS _glog_severity_headers)
    file(READ "${_glog_severity}" _glog_severity_content)
    string(REPLACE "#  error ERROR macro is defined." "#  undef ERROR /* patched for Windows */ //"
      _glog_severity_content "${_glog_severity_content}")
    file(WRITE "${_glog_severity}" "${_glog_severity_content}")
  endforeach()
else()
  configure_file("${_rn_third_party}/glog/config.h" "${_dst}/glog-0.3.5/src/config.h" COPYONLY)
endif()
foreach(_header IN ITEMS stl_logging.h logging.h raw_logging.h vlog_is_on.h log_severity.h)
  if(EXISTS "${_dst}/glog-0.3.5/src/${_header}")
    configure_file("${_dst}/glog-0.3.5/src/${_header}" "${_dst}/exported/glog/${_header}" COPYONLY)
  elseif(EXISTS "${_dst}/glog-0.3.5/src/glog/${_header}")
    configure_file("${_dst}/glog-0.3.5/src/glog/${_header}" "${_dst}/exported/glog/${_header}" COPYONLY)
  endif()
endforeach()

set(_dst "${RN_GPUI_NATIVE_DEPS_PREPARED}/nlohmann_json")
file(REMOVE_RECURSE "${_dst}")
file(MAKE_DIRECTORY "${_dst}")
file(GLOB _json_root LIST_DIRECTORIES TRUE "${RN_GPUI_NLOHMANN_JSON_ARCHIVE_DIR}/json-3.11.2*")
list(GET _json_root 0 _json_root)
file(COPY "${_json_root}/include" DESTINATION "${_dst}")
