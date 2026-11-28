package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType

/**
 * What a pill shows: the variant's default, or one specific link's override keyed by
 * exact URL in the `linkPillContent` prop. Empty strings mean "not set".
 */
data class LinkPillContent(
  val label: String = "",
  val iconUri: String = "",
  /** Tint for this link's icon; null means none was set for the link. */
  val iconTintColor: Int? = null,
) {
  /**
   * Label and icon unset here take their value from [fallback]. The tint is left alone:
   * a variant's tint is for the variant's own icon, so the span decides when it applies.
   */
  fun orElse(fallback: LinkPillContent) =
    copy(
      label = label.ifEmpty { fallback.label },
      iconUri = iconUri.ifEmpty { fallback.iconUri },
    )

  companion object {
    fun fromReadableMap(map: ReadableMap): LinkPillContent {
      val hasTint = map.hasKey("iconTintColor") && map.getType("iconTintColor") == ReadableType.Number
      return LinkPillContent(
        label = map.getString("label") ?: "",
        iconUri = map.getString("iconUri") ?: "",
        iconTintColor = if (hasTint) map.getDouble("iconTintColor").toInt() else null,
      )
    }
  }
}
