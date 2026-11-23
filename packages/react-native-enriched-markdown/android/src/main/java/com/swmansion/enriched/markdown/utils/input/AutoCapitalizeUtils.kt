package com.swmansion.enriched.markdown.utils.input

import android.text.InputType
import android.widget.EditText

object AutoCapitalizeUtils {
  fun apply(
    editText: EditText,
    flagName: String?,
  ) {
    val flag =
      when (flagName) {
        "none" -> InputType.TYPE_NULL
        "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
        "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        else -> InputType.TYPE_NULL
      }

    editText.inputType = (
      editText.inputType and
        InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS.inv() and
        InputType.TYPE_TEXT_FLAG_CAP_WORDS.inv() and
        InputType.TYPE_TEXT_FLAG_CAP_SENTENCES.inv()
    ) or if (flag == InputType.TYPE_NULL) 0 else flag
  }
}
