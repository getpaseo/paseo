package com.swmansion.enriched.markdown.utils.common

import com.facebook.react.bridge.ReadableMap

data class LinkRecognition(
  val text: LinkRegexConfig? = null,
  val inlineCode: LinkRegexConfig? = null,
) {
  companion object {
    val NONE = LinkRecognition()
  }
}

internal fun parseLinkRecognition(map: ReadableMap?): LinkRecognition {
  if (map == null) return LinkRecognition.NONE
  return LinkRecognition(
    text = parseLinkRegexConfig(map.getMapOrNull("text")),
    inlineCode = parseLinkRegexConfig(map.getMapOrNull("inlineCode")),
  )
}

internal fun parseLinkRegexConfig(map: ReadableMap?): LinkRegexConfig? {
  if (map == null) return null
  return LinkRegexConfig(
    pattern = if (map.hasKey("pattern")) map.getString("pattern") ?: "" else "",
    caseInsensitive = map.hasKey("caseInsensitive") && map.getBoolean("caseInsensitive"),
    dotAll = map.hasKey("dotAll") && map.getBoolean("dotAll"),
    isDisabled = !map.hasKey("isDisabled") || map.getBoolean("isDisabled"),
    isDefault = map.hasKey("isDefault") && map.getBoolean("isDefault"),
  )
}
