# Android CMake helper shim

This directory contains only `SoMerging-utils.cmake`, included by React
Native's `jsinspector-modern` CMake files through `REACT_ANDROID_DIR`. The
helper defines `target_merge_so()`, which is intentionally a no-op on GPUI's
non-Android desktop builds. No Android JNI, Java, or runtime implementation is
compiled or shipped from this directory.
