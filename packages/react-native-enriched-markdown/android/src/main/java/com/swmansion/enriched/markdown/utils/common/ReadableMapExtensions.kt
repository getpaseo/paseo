package com.swmansion.enriched.markdown.utils.common

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

fun ReadableMap?.getBooleanOrDefault(
  key: String,
  default: Boolean,
): Boolean = if (this?.hasKey(key) == true) getBoolean(key) else default

fun ReadableMap?.getFloatOrDefault(
  key: String,
  default: Float,
): Float = if (this?.hasKey(key) == true) getDouble(key).toFloat() else default

fun ReadableMap?.getIntOrDefault(
  key: String,
  default: Int,
): Int = if (this?.hasKey(key) == true) getDouble(key).toInt() else default

fun ReadableMap?.getStringOrDefault(
  key: String,
  default: String,
): String = if (this?.hasKey(key) == true) getString(key) ?: default else default

fun ReadableMap?.getMapOrNull(key: String): ReadableMap? = if (this?.hasKey(key) == true) getMap(key) else null

fun ReadableMap?.getArrayOrNull(key: String): ReadableArray? = if (this?.hasKey(key) == true) getArray(key) else null
