package com.swmansion.enriched.markdown.utils.common

import android.view.View
import com.swmansion.enriched.markdown.EnrichedMarkdown

fun View.findEnrichedMarkdownAncestor(): EnrichedMarkdown? {
  var current = parent
  while (current != null && current !is EnrichedMarkdown) current = current.parent
  return current as? EnrichedMarkdown
}
