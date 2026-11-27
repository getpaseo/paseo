package com.swmansion.enriched.markdown.input.detection

import android.text.Spannable
import com.swmansion.enriched.markdown.input.model.FormattingRange

/**
 * Coordinates a set of [TextDetector] instances. The input view calls
 * this pipeline instead of individual detectors.
 */
class DetectorPipeline {
  private val detectors = mutableListOf<TextDetector>()

  fun addDetector(detector: TextDetector) {
    detectors.add(detector)
  }

  fun processTextChange(
    spannable: Spannable,
    text: String,
    editStart: Int,
    editLength: Int,
  ) {
    val words = WordsUtils.getAffectedWords(text, editStart, editLength)

    for (wordResult in words) {
      for (detector in detectors) {
        detector.processWord(spannable, wordResult)
      }
    }
  }

  fun refreshAllStyling(spannable: Spannable) {
    for (detector in detectors) {
      detector.refreshStyling(spannable)
    }
  }

  fun allTransientFormattingRanges(spannable: Spannable): List<FormattingRange> =
    detectors.flatMap { it.transientFormattingRanges(spannable) }
}
