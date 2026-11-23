package com.swmansion.enriched.markdown.input.editing

import android.text.Editable
import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView

class MarkdownEditableFactory(
  private val view: EnrichedMarkdownTextInputView,
) : Editable.Factory() {
  override fun newEditable(source: CharSequence): Editable {
    val builder = (source as? SpannableStringBuilder) ?: SpannableStringBuilder(source)
    view.attachTextWatcher(builder)
    return builder
  }
}
