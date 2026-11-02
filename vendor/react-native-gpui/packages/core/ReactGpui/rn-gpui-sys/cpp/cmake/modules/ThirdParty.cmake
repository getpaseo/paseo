add_subdirectory("${RN_GPUI_NATIVE_DEPS_PREPARED}/glog" "${RN_GPUI_NATIVE_DEPS_BUILD}/glog")
if(WIN32)
  # glog's utilities.h includes "port.h" when OS_WINDOWS is defined, and that
  # header lives in glog-<version>/src/windows. RN's Android-first CMakeLists
  # only exposes the project root and exported/ to the compiler.
  file(GLOB _rn_gpui_glog_windows_include
    "${RN_GPUI_NATIVE_DEPS_PREPARED}/glog/glog-*/src/windows")
  if(_rn_gpui_glog_windows_include)
    target_include_directories(glog PRIVATE ${_rn_gpui_glog_windows_include})
  endif()
  # glog 0.3.5 predates VS2015's C99 snprintf and would declare its own
  # (C2375: redefinition; different linkage); HAVE_SNPRINTF skips that
  # declaration. Its symbolize.cc uses the DbgHelp API.
  target_compile_definitions(glog PRIVATE HAVE_SNPRINTF=1)
  target_link_libraries(glog PUBLIC dbghelp)
  # ReactAndroid's glog source list omits src/windows/port.cc, which provides
  # safe_vsnprintf (used by raw_logging) and the other Windows shims.
  file(GLOB _rn_gpui_glog_windows_sources
    "${RN_GPUI_NATIVE_DEPS_PREPARED}/glog/glog-*/src/windows/*.cc")
  if(_rn_gpui_glog_windows_sources)
    target_sources(glog PRIVATE ${_rn_gpui_glog_windows_sources})
  endif()
endif()
add_subdirectory("${RN_GPUI_NATIVE_DEPS_PREPARED}/double-conversion" "${RN_GPUI_NATIVE_DEPS_BUILD}/double-conversion")
add_subdirectory("${RN_GPUI_NATIVE_DEPS_PREPARED}/fast_float" "${RN_GPUI_NATIVE_DEPS_BUILD}/fast_float")
add_subdirectory("${RN_GPUI_NATIVE_DEPS_PREPARED}/fmt" "${RN_GPUI_NATIVE_DEPS_BUILD}/fmt")
add_subdirectory("${RN_GPUI_NATIVE_DEPS_PREPARED}/folly" "${RN_GPUI_NATIVE_DEPS_BUILD}/folly")
# RN's reduced Folly target omits platform-neutral sources used by
# ReactCxxPlatform's HTTP and threading implementations on desktop targets.
target_sources(folly_runtime PRIVATE
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/system/ThreadName.cpp"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/io/IOBuf.cpp"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/Uri.cpp"
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/memory/SanitizeAddress.cpp")
if(WIN32)
  # On Windows folly routes POSIX calls (close, dup, sysconf, open, mmap,
  # getrusage) through folly/portability/*.cpp, which Android never needs.
  # Unistd.cpp closes sockets through SocketFileDescriptorMap, and MSVC
  # references the leak annotations that clang folds away.
  file(GLOB _rn_gpui_folly_portability
    "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/portability/*.cpp")
  list(FILTER _rn_gpui_folly_portability EXCLUDE REGEX "/SysUio\\.cpp$")
  target_sources(folly_runtime PRIVATE
    ${_rn_gpui_folly_portability}
    "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/net/detail/SocketFileDescriptorMap.cpp"
    "${RN_GPUI_NATIVE_DEPS_PREPARED}/folly/folly/memory/SanitizeLeak.cpp")
  target_link_libraries(folly_runtime ws2_32)
  # portability/PThread.cpp implements pthread keys with
  # boost::thread_specific_ptr, which lives in compiled Boost.Thread. Only
  # its Win32 TSS sources are needed; tss_pe.cpp runs the per-thread cleanup.
  set(_rn_gpui_boost_thread
    "${RN_GPUI_NATIVE_DEPS_SOURCES}/boost/boost_1_83_0/libs/thread/src/win32")
  target_sources(folly_runtime PRIVATE
    "${_rn_gpui_boost_thread}/thread.cpp"
    "${_rn_gpui_boost_thread}/thread_primitives.cpp"
    "${_rn_gpui_boost_thread}/tss_pe.cpp")
  set_source_files_properties(
    "${_rn_gpui_boost_thread}/thread.cpp"
    "${_rn_gpui_boost_thread}/thread_primitives.cpp"
    "${_rn_gpui_boost_thread}/tss_pe.cpp"
    TARGET_DIRECTORY folly_runtime
    PROPERTIES COMPILE_DEFINITIONS "BOOST_THREAD_BUILD_LIB;BOOST_CHRONO_HEADER_ONLY")
endif()

add_library(boost INTERFACE)
target_include_directories(boost INTERFACE
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/boost/boost_1_83_0"
  "${RN_GPUI_OPENSSL_INSTALL}/include")

add_library(nlohmann_json INTERFACE)
target_include_directories(nlohmann_json INTERFACE
  "${RN_GPUI_NATIVE_DEPS_PREPARED}/nlohmann_json/include")
add_library(double_conversion ALIAS double-conversion)

# folly -> folly_runtime (RN's name for this dependency).
# fbgloginit and fbjni are Android/JNI-only.
add_library(glog_init INTERFACE)
add_library(fbjni INTERFACE)

find_package(OpenSSL REQUIRED)

# The Hermes VM and the React Native Hermes glue live in the engine package
# @react-native-gpui/hermes/desktop/CMakeLists.txt, which autolink adds when the
# package is installed. Core has no engine of its own.
