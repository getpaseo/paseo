package com.swmansion.enriched.markdown.input.detection

import android.text.Spannable
import com.swmansion.enriched.markdown.input.model.FormattingRange

/**
 * Interface for pluggable text detectors that run after each text edit.
 * Each detector processes affected words, can refresh its own visual styling
 * after the formatter resets spans, and contributes transient formatting ranges
 * for markdown serialization.
 */
interface TextDetector {
  /** Process a single word at the given range after a text edit. */
  fun processWord(
    spannable: Spannable,
    wordResult: WordResult,
  )

  /** Re-apply any visual styling owned by this detector. */
  fun refreshStyling(spannable: Spannable)

  /**
   * Return transient formatting ranges that should be merged
   * with the FormattingStore ranges during markdown serialization.
   */
  fun transientFormattingRanges(spannable: Spannable): List<FormattingRange>
}
