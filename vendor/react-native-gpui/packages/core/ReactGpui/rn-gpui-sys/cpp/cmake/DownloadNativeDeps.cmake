# Everything downloaded, extracted or built from the pinned native-dep archives
# lives in one per-user cache that every build of every checkout shares, so a
# new target dir or worktree does not download Boost or build OpenSSL again.
# Layout (nothing here depends on the build dir):
#   downloads/<sha256[:12]>/<archive>   verified archives
#   sources/<name>-<sha256[:12]>/       extracted archives, never modified
#   openssl/<key>/install               static OpenSSL, one per toolchain key
#   locks/                              lock files serialising concurrent builds
# build.rs passes the folder as -DRN_GPUI_NATIVE_DEPS_CACHE (the user cache
# folder, or RN_GPUI_NATIVE_DEPS_CACHE). A CMake run by hand uses the environment
# variable, then falls back to a folder in the build dir, as builds did before.
if(NOT RN_GPUI_NATIVE_DEPS_CACHE)
  if(NOT "$ENV{RN_GPUI_NATIVE_DEPS_CACHE}" STREQUAL "")
    set(RN_GPUI_NATIVE_DEPS_CACHE "$ENV{RN_GPUI_NATIVE_DEPS_CACHE}")
  else()
    set(RN_GPUI_NATIVE_DEPS_CACHE "${CMAKE_BINARY_DIR}/native-deps/cache")
  endif()
endif()
file(TO_CMAKE_PATH "${RN_GPUI_NATIVE_DEPS_CACHE}" RN_GPUI_NATIVE_DEPS_CACHE)
set(RN_GPUI_NATIVE_DEPS_DOWNLOADS "${RN_GPUI_NATIVE_DEPS_CACHE}/downloads")
set(RN_GPUI_NATIVE_DEPS_SOURCES "${RN_GPUI_NATIVE_DEPS_CACHE}/sources")
set(RN_GPUI_NATIVE_DEPS_LOCKS "${RN_GPUI_NATIVE_DEPS_CACHE}/locks")
# What depends on this build's flags and React Native version stays in the build
# dir: the prepared copies of the sources, and the third-party CMake builds.
set(RN_GPUI_NATIVE_DEPS_PREPARED "${CMAKE_BINARY_DIR}/native-deps/third-party-ndk")
message(STATUS "Native dependency cache: ${RN_GPUI_NATIVE_DEPS_CACHE}")
file(MAKE_DIRECTORY "${RN_GPUI_NATIVE_DEPS_DOWNLOADS}" "${RN_GPUI_NATIVE_DEPS_SOURCES}"
  "${RN_GPUI_NATIVE_DEPS_LOCKS}")

# Holds a lock on the cache until the calling function returns. Locks are
# released by the operating system when a build dies, and the wait is bounded
# because another build may be downloading Boost or compiling OpenSSL.
macro(rn_gpui_native_deps_lock lock_name)
  file(LOCK "${RN_GPUI_NATIVE_DEPS_LOCKS}/${lock_name}.lock" GUARD FUNCTION
    TIMEOUT 3600 RESULT_VARIABLE _rn_gpui_lock_result)
  if(NOT _rn_gpui_lock_result EQUAL 0)
    message(FATAL_ERROR
      "Timed out waiting for another build to finish with ${lock_name} in "
      "${RN_GPUI_NATIVE_DEPS_CACHE} (${_rn_gpui_lock_result}). If no build is "
      "running, delete ${RN_GPUI_NATIVE_DEPS_LOCKS}/${lock_name}.lock.")
  endif()
endmacro()

# Downloads one archive into the cache and checks it against its pinned sha256.
# A bad copy in the cache (a truncated or tampered file) is downloaded again.
function(rn_gpui_fetch_archive archive_name url sha256 out_archive)
  string(SUBSTRING "${sha256}" 0 12 _id)
  set(_dir "${RN_GPUI_NATIVE_DEPS_DOWNLOADS}/${_id}")
  set(_archive "${_dir}/${archive_name}")
  file(MAKE_DIRECTORY "${_dir}")
  rn_gpui_native_deps_lock("download-${_id}")
  if(EXISTS "${_archive}")
    file(SHA256 "${_archive}" _actual)
    if(NOT _actual STREQUAL sha256)
      message(WARNING "${_archive} has sha256 ${_actual}, expected ${sha256}; downloading it again")
      file(REMOVE "${_archive}")
    endif()
  endif()
  if(NOT EXISTS "${_archive}")
    message(STATUS "Downloading ${archive_name} into ${_dir}")
    set(_download_succeeded FALSE)
    set(_download_message "")
    foreach(_attempt RANGE 1 5)
      # The partial file is private to the lock holder and only renamed once
      # complete and verified, so no build ever sees a half-written archive.
      set(_partial_archive "${_archive}.part")
      file(REMOVE "${_partial_archive}")
      # No overall TIMEOUT: Boost is 145 MB, and a cap on the whole transfer
      # fails every attempt on a slow link however steadily it downloads.
      file(DOWNLOAD "${url}" "${_partial_archive}" SHOW_PROGRESS TLS_VERIFY ON
        INACTIVITY_TIMEOUT 45 STATUS _download_status)
      list(GET _download_status 0 _download_code)
      list(GET _download_status 1 _download_message)
      if(_download_code EQUAL 0)
        file(SHA256 "${_partial_archive}" _actual)
        if(_actual STREQUAL sha256)
          file(RENAME "${_partial_archive}" "${_archive}")
          set(_download_succeeded TRUE)
          break()
        endif()
        set(_download_message "sha256 is ${_actual}, expected ${sha256}")
      endif()
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
  set(${out_archive} "${_archive}" PARENT_SCOPE)
endfunction()

# Makes the archive's contents available at ${out_source}, which is the
# directory that holds the archive's top-level folder.
function(rn_gpui_download_extract name archive_name url sha256 out_source)
  string(SUBSTRING "${sha256}" 0 12 _id)
  set(_source "${RN_GPUI_NATIVE_DEPS_SOURCES}/${name}-${_id}")
  set_property(GLOBAL APPEND PROPERTY RN_GPUI_NATIVE_DEPS_ARCHIVES "${archive_name} ${sha256}")
  # A folder only appears under its final name once it is completely extracted
  # from a verified archive, so its existence is the whole check.
  if(NOT EXISTS "${_source}")
    rn_gpui_native_deps_lock("source-${name}-${_id}")
    if(NOT EXISTS "${_source}")
      rn_gpui_fetch_archive("${archive_name}" "${url}" "${sha256}" _archive)
      set(_extract_dir "${_source}.tmp")
      file(REMOVE_RECURSE "${_extract_dir}")
      file(MAKE_DIRECTORY "${_extract_dir}")
      message(STATUS "Extracting ${archive_name} into ${_source}")
      file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_extract_dir}")
      file(RENAME "${_extract_dir}" "${_source}")
    endif()
  endif()
  set(${out_source} "${_source}" PARENT_SCOPE)
endfunction()

# Keep these versions and source URLs aligned with node_modules/react-native/
# gradle/libs.versions.toml and ReactAndroid/build.gradle.kts.
#
# Each archive is pinned by sha256: change the checksum with the version.
rn_gpui_download_extract(boost "boost_1_83_0.tar.gz"
  "https://archives.boost.io/release/1.83.0/source/boost_1_83_0.tar.gz"
  "c0685b68dd44cc46574cce86c4e17c0f611b15e195be9848dfd0769a0a207628" RN_GPUI_BOOST_ARCHIVE_DIR)
rn_gpui_download_extract(double-conversion "double-conversion-1.1.6.tar.gz"
  "https://github.com/google/double-conversion/archive/v1.1.6.tar.gz"
  "6b850acd8e88515764472c52973277744a945f9a769a93968efc42efef64d67a" RN_GPUI_DOUBLE_CONVERSION_ARCHIVE_DIR)
rn_gpui_download_extract(fast_float "fast_float-8.0.0.tar.gz"
  "https://github.com/fastfloat/fast_float/archive/v8.0.0.tar.gz"
  "f312f2dc34c61e665f4b132c0307d6f70ad9420185fa831911bc24408acf625d" RN_GPUI_FAST_FLOAT_ARCHIVE_DIR)
rn_gpui_download_extract(fmt "fmt-12.1.0.tar.gz"
  "https://github.com/fmtlib/fmt/archive/12.1.0.tar.gz"
  "ea7de4299689e12b6dddd392f9896f08fb0777ac7168897a244a6d6085043fea" RN_GPUI_FMT_ARCHIVE_DIR)
rn_gpui_download_extract(folly "folly-2024.11.18.00.tar.gz"
  "https://github.com/facebook/folly/archive/v2024.11.18.00.tar.gz"
  "b2c6879ba8ba625218d1ab9eefcc1611a9003d05bc2cb1a38f3bae21892e5167" RN_GPUI_FOLLY_ARCHIVE_DIR)
rn_gpui_download_extract(glog "glog-0.3.5.tar.gz"
  "https://github.com/google/glog/archive/v0.3.5.tar.gz"
  "7580e408a2c0b5a89ca214739978ce6ff480b5e7d8d7698a2aa92fadc484d1e0" RN_GPUI_GLOG_ARCHIVE_DIR)
rn_gpui_download_extract(nlohmann_json "json-3.11.2.tar.gz"
  "https://github.com/nlohmann/json/archive/v3.11.2.tar.gz"
  "d69f9deb6a75e2580465c6c4c5111b89c4dc2fa94e3a85fcd2ffcd9a143d9273" RN_GPUI_NLOHMANN_JSON_ARCHIVE_DIR)
rn_gpui_download_extract(curl "curl-8.11.1.tar.gz"
  "https://curl.se/download/curl-8.11.1.tar.gz"
  "a889ac9dbba3644271bd9d1302b5c22a088893719b72be3487bc3d401e5c4e80" RN_GPUI_CURL_ARCHIVE_DIR)
# OpenSSL is only needed to build it, so its archive is fetched by
# rn_gpui_build_openssl below and only when no built copy is cached.
set(RN_GPUI_OPENSSL_ARCHIVE_NAME "openssl-3.3.2.tar.gz")
set(RN_GPUI_OPENSSL_ARCHIVE_URL "https://www.openssl.org/source/openssl-3.3.2.tar.gz")
set(RN_GPUI_OPENSSL_ARCHIVE_SHA256 "2e8a40b01979afe8be0bbfb3de5dc1c6709fedb46d6c89c10da114ab5fc3d281")

# OpenSSL's upstream project uses Configure + Make rather than CMake. Build a
# static copy into the shared cache before CMake discovers it; this keeps CURL
# and ReactCxxPlatform off host OpenSSL installations.
if(WIN32)
  # The VS developer environment must be active so OpenSSL uses the same
  # MSVC toolchain/runtime as React Native and the GPUI host.
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
    set(_openssl_target VC-WIN64A)
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|arm64|aarch64")
    set(_openssl_target VC-WIN64-ARM)
  else()
    message(FATAL_ERROR "No OpenSSL source-build target for Windows/${CMAKE_SYSTEM_PROCESSOR}")
  endif()
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
set(_openssl_configure_options no-shared no-tests no-apps)
set(_openssl_env ${CMAKE_COMMAND} -E env)
set(_openssl_sdk "")
if(APPLE)
  execute_process(COMMAND xcrun --sdk macosx --show-sdk-path
    OUTPUT_VARIABLE _openssl_sdk OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _openssl_sdk_status)
  if(NOT _openssl_sdk_status EQUAL 0 OR _openssl_sdk STREQUAL "")
    message(FATAL_ERROR "xcrun could not locate the macOS SDK for OpenSSL")
  endif()
  set(_openssl_env ${CMAKE_COMMAND} -E env "SDKROOT=${_openssl_sdk}")
endif()

# The installed copy is keyed by everything that changes what OpenSSL compiles
# to: the target, the build type, the compiler and the flags Configure reads
# from the environment. Builds that differ in any of them each get their own
# copy, so they never overwrite or reuse each other's.
set(_openssl_key_inputs
  "openssl=3.3.2" "sha256=${RN_GPUI_OPENSSL_ARCHIVE_SHA256}"
  "target=${_openssl_target}" "options=${_openssl_configure_options}"
  "system=${CMAKE_SYSTEM_NAME}" "processor=${CMAKE_SYSTEM_PROCESSOR}"
  "build_type=${CMAKE_BUILD_TYPE}"
  "compiler=${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}"
  "osx_deployment_target=${CMAKE_OSX_DEPLOYMENT_TARGET}"
  "osx_architectures=${CMAKE_OSX_ARCHITECTURES}" "sdk=${_openssl_sdk}")
# Configure reads these; the cc crate never sets them, but a user may.
foreach(_openssl_env_var IN ITEMS CC CFLAGS CPPFLAGS LDFLAGS MACOSX_DEPLOYMENT_TARGET SDKROOT)
  list(APPEND _openssl_key_inputs "env_${_openssl_env_var}=$ENV{${_openssl_env_var}}")
endforeach()
string(JOIN "\n" _openssl_key_text ${_openssl_key_inputs})
string(SHA256 _openssl_key_hash "${_openssl_key_text}")
string(SUBSTRING "${_openssl_key_hash}" 0 16 _openssl_key_hash)
string(TOLOWER "${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}-${CMAKE_BUILD_TYPE}" _openssl_key_name)
set(RN_GPUI_OPENSSL_DIR
  "${RN_GPUI_NATIVE_DEPS_CACHE}/openssl/3.3.2-${_openssl_key_name}-${_openssl_key_hash}")
set(RN_GPUI_OPENSSL_INSTALL "${RN_GPUI_OPENSSL_DIR}/install")
# Written last, once the install is whole; a folder without it is a build that
# was interrupted and is started again.
set(_openssl_complete_marker "${RN_GPUI_OPENSSL_DIR}/.complete")

function(rn_gpui_build_openssl)
  rn_gpui_native_deps_lock("openssl-${_openssl_key_hash}")
  # Another build may have finished the install while this one waited.
  if(EXISTS "${_openssl_complete_marker}")
    return()
  endif()
  # The install prefix is compiled into the libraries, so the install cannot be
  # built elsewhere and renamed into place; the marker plays that part.
  file(REMOVE_RECURSE "${RN_GPUI_OPENSSL_DIR}")
  set(_openssl_work "${RN_GPUI_OPENSSL_DIR}/work")
  file(MAKE_DIRECTORY "${_openssl_work}")
  rn_gpui_fetch_archive("${RN_GPUI_OPENSSL_ARCHIVE_NAME}" "${RN_GPUI_OPENSSL_ARCHIVE_URL}"
    "${RN_GPUI_OPENSSL_ARCHIVE_SHA256}" _openssl_archive)
  # Configure and make build inside the source tree, so every key builds in a
  # copy of its own and the cached sources stay untouched.
  file(ARCHIVE_EXTRACT INPUT "${_openssl_archive}" DESTINATION "${_openssl_work}")
  file(GLOB _openssl_roots LIST_DIRECTORIES TRUE "${_openssl_work}/openssl-3.3.2*")
  list(GET _openssl_roots 0 RN_GPUI_OPENSSL_SOURCE_DIR)
  message(STATUS "Building OpenSSL ${_openssl_target} into ${RN_GPUI_OPENSSL_INSTALL}")
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
  else()
    find_program(RN_GPUI_MAKE_EXECUTABLE make REQUIRED)
  endif()
  execute_process(
    COMMAND ${_openssl_env} "${RN_GPUI_PERL_EXECUTABLE}" ./Configure "${_openssl_target}" ${_openssl_configure_options}
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
    message(FATAL_ERROR "Installing cached OpenSSL into the shared cache failed")
  endif()
  file(REMOVE_RECURSE "${_openssl_work}")
  file(WRITE "${_openssl_complete_marker}" "${_openssl_key_text}\n")
endfunction()

# Prebuilt mode: the archive carries OpenSSL's libraries and generated headers,
# so nothing is built here.
if(NOT RN_GPUI_PREBUILT_DIR)
  set_property(GLOBAL APPEND PROPERTY RN_GPUI_NATIVE_DEPS_ARCHIVES
    "${RN_GPUI_OPENSSL_ARCHIVE_NAME} ${RN_GPUI_OPENSSL_ARCHIVE_SHA256}")
  if(NOT EXISTS "${_openssl_complete_marker}")
    rn_gpui_build_openssl()
  else()
    message(STATUS "Using cached OpenSSL ${RN_GPUI_OPENSSL_INSTALL}")
  endif()
endif()
list(PREPEND CMAKE_PREFIX_PATH "${RN_GPUI_OPENSSL_INSTALL}")
set(OPENSSL_ROOT_DIR "${RN_GPUI_OPENSSL_INSTALL}" CACHE PATH "GPUI build-cache OpenSSL" FORCE)
set(OPENSSL_USE_STATIC_LIBS TRUE)

file(GLOB _curl_roots LIST_DIRECTORIES TRUE "${RN_GPUI_CURL_ARCHIVE_DIR}/curl-8.11.1*")
list(GET _curl_roots 0 RN_GPUI_CURL_SOURCE_DIR)

file(MAKE_DIRECTORY "${RN_GPUI_NATIVE_DEPS_PREPARED}")
set(RN_GPUI_NATIVE_DEPS_BUILD "${CMAKE_BINARY_DIR}/native-deps/build")
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

# The archives (name and sha256) this build used, for scripts/build-prebuilt.mjs
# to list in the manifest; the shared cache holds archives of other builds too.
get_property(_rn_gpui_native_deps_archives GLOBAL PROPERTY RN_GPUI_NATIVE_DEPS_ARCHIVES)
list(SORT _rn_gpui_native_deps_archives)
string(JOIN "\n" _rn_gpui_native_deps_archives_text ${_rn_gpui_native_deps_archives})
file(WRITE "${CMAKE_BINARY_DIR}/native-deps/archives.txt" "${_rn_gpui_native_deps_archives_text}\n")
