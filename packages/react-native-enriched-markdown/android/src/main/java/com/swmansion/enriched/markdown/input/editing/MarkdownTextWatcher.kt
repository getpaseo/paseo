package com.swmansion.enriched.markdown.input.editing

import android.text.Editable
import android.text.TextWatcher
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView

class MarkdownTextWatcher(
  private val view: EnrichedMarkdownTextInputView,
) : TextWatcher {
  private var editStart = 0
  private var deletedLength = 0
  private var insertedLength = 0

  override fun beforeTextChanged(
    text: CharSequence,
    start: Int,
    count: Int,
    after: Int,
  ) {
    if (view.editSession.shouldSuppressTextWatcher) return
    editStart = start
    deletedLength = count
    insertedLength = after
    view.onBeforeTextChanged()
  }

  override fun onTextChanged(
    text: CharSequence,
    start: Int,
    before: Int,
    count: Int,
  ) = Unit

  override fun afterTextChanged(editable: Editable) {
    if (view.editSession.shouldSuppressTextWatcher) return
    view.onAfterTextChanged(editStart, deletedLength, insertedLength)
  }
}
