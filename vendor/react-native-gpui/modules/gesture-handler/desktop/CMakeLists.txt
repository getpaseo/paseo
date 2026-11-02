if(NOT RN_GPUI_PROJECT_ROOT)
  message(FATAL_ERROR
    "@react-native-gpui/gesture-handler was added by the platform; RN_GPUI_PROJECT_ROOT must be set by its build.rs")
endif()
rn_gpui_find_node_module(react-native-gesture-handler _gesture_root)
if(NOT EXISTS "${_gesture_root}/src/specs/NativeRNGestureHandlerModule.ts")
  message(FATAL_ERROR "react-native-gesture-handler 3.3.x was not found at ${_gesture_root}")
endif()

file(READ "${_gesture_root}/package.json" _gesture_package_json)
string(JSON _gesture_version GET "${_gesture_package_json}" version)
if(NOT _gesture_version MATCHES "^3\\.3\\.")
  message(FATAL_ERROR "@react-native-gpui/gesture-handler supports react-native-gesture-handler 3.3.x, found ${_gesture_version}")
endif()

set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_SOURCES
  "${CMAKE_CURRENT_LIST_DIR}/cpp/GPUIGestureHandlerModule.cpp")
set_property(GLOBAL APPEND PROPERTY RN_GPUI_APP_CPP_INCLUDE_DIRS
  "${RN_GPUI_SYS_CPP_DIR}")
