package com.swmansion.enriched.markdown.input.editing

import com.swmansion.enriched.markdown.input.detection.WordsUtils
import com.swmansion.enriched.markdown.input.formatting.FormattingStore
import com.swmansion.enriched.markdown.input.model.StyleType

sealed class MentionEvent {
  data class Start(
    val indicator: String,
  ) : MentionEvent()

  data class Change(
    val indicator: String,
    val text: String,
  ) : MentionEvent()

  data class End(
    val indicator: String,
  ) : MentionEvent()
}

class MentionCoordinator(
  private val formattingStore: FormattingStore,
) {
  private var indicators: LinkedHashSet<String> = linkedSetOf()
  private var activeIndicator: String? = null
  private var activeStart = -1
  private var activeEnd = -1
  private var activeText = ""

  val isActive: Boolean get() = activeIndicator != null
  val currentIndicator: String? get() = activeIndicator
  val currentStart: Int get() = activeStart
  val currentEnd: Int get() = activeEnd

  fun containsIndicator(indicator: String): Boolean = indicator in indicators

  fun setIndicators(newIndicators: List<String>): List<MentionEvent> {
    val newSet = LinkedHashSet(newIndicators)
    if (newSet == indicators) return emptyList()
    indicators = newSet
    val events = mutableListOf<MentionEvent>()
    activeIndicator?.let { indicator ->
      if (indicator !in indicators) {
        events.addAll(clear(indicatorOverride = indicator))
      }
    }
    return events
  }

  /**
   * Re-evaluates the active mention based on the current cursor and text.
   * Pass null [plainText] to force-clear (e.g. when the editable is absent).
   */
  fun update(
    plainText: String?,
    selStart: Int,
    selEnd: Int,
  ): List<MentionEvent> {
    if (plainText == null || selStart != selEnd || selStart < 0 || selStart > plainText.length) {
      return clear()
    }

    val candidate = detectCandidate(plainText, selStart) ?: return clear()
    val events = mutableListOf<MentionEvent>()

    if (activeIndicator != candidate.indicator || activeStart != candidate.start) {
      activeIndicator?.let { events.add(MentionEvent.End(it)) }
      activeIndicator = candidate.indicator
      activeStart = candidate.start
      events.add(MentionEvent.Start(candidate.indicator))
    }

    activeEnd = candidate.end
    if (activeText != candidate.text) {
      activeText = candidate.text
      events.add(MentionEvent.Change(candidate.indicator, candidate.text))
    }
    return events
  }

  fun clear(
    emit: Boolean = true,
    indicatorOverride: String? = null,
  ): List<MentionEvent> {
    val indicator = indicatorOverride ?: activeIndicator
    activeIndicator = null
    activeStart = -1
    activeEnd = -1
    activeText = ""
    return if (emit && indicator != null) listOf(MentionEvent.End(indicator)) else emptyList()
  }

  private fun detectCandidate(
    plainText: String,
    cursor: Int,
  ): MentionCandidate? {
    if (indicators.isEmpty()) return null
    val start = WordsUtils.tokenStart(plainText, cursor)
    val token = plainText.substring(start, cursor)
    val indicator = indicators.firstOrNull { token.startsWith(it) } ?: return null
    if (formattingStore.rangeOfType(StyleType.LINK, start) != null) return null

    return MentionCandidate(
      indicator = indicator,
      start = start,
      end = cursor,
      text = token.substring(indicator.length),
    )
  }

  private data class MentionCandidate(
    val indicator: String,
    val start: Int,
    val end: Int,
    val text: String,
  )
}
