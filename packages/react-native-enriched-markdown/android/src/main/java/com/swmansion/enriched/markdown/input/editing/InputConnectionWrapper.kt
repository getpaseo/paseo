package com.swmansion.enriched.markdown.input.editing

import android.view.KeyEvent
import android.view.inputmethod.InputConnection
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView
import android.view.inputmethod.InputConnectionWrapper as AndroidInputConnectionWrapper

/**
 * Intercepts IME traffic for two purposes: atomic link deletion (a backspace
 * right after a link removes the whole link) and the `onKeyPress` event.
 *
 * Key derivation mirrors React Native's ReactEditTextInputConnectionWrapper.
 * Soft keyboards don't report discrete key presses; the pressed key is inferred
 * from InputConnection side effects:
 * - [setComposingText] receives the whole composing region, not a one-character
 *   diff, so the key is derived from cursor movement: a cursor that moved
 *   backwards (or stayed put while collapsing a selection) means "Backspace",
 *   otherwise the key is the character left of the cursor.
 * - [commitText] with an empty string means "Backspace"; short strings (a char,
 *   or a surrogate pair) are the key itself; longer strings are autocomplete
 *   insertions, not key presses.
 * - [deleteSurroundingText] is a backspace with nothing to compose.
 * - [sendKeyEvent] is used by some keyboards (e.g. SwiftKey) for delete/enter
 *   and by number-pad keys.
 * IMEs wrap composed-word commits in a batch edit that ends with the actual
 * user input, so during a batch only the last inferred key is emitted at
 * [endBatchEdit]. Newlines are normalized to "Enter".
 */
class InputConnectionWrapper(
  target: InputConnection,
  private val editText: EnrichedMarkdownTextInputView,
) : AndroidInputConnectionWrapper(target, false) {
  var isBatchEdit = false
    private set

  private var pendingKey: String? = null

  override fun beginBatchEdit(): Boolean {
    isBatchEdit = true
    return super.beginBatchEdit()
  }

  override fun endBatchEdit(): Boolean {
    isBatchEdit = false
    pendingKey?.let {
      dispatchKeyPress(it)
      pendingKey = null
    }
    return super.endBatchEdit()
  }

  override fun setComposingText(
    text: CharSequence,
    newCursorPosition: Int,
  ): Boolean {
    val previousSelectionStart = editText.selectionStart
    val previousSelectionEnd = editText.selectionEnd

    val consumed = super.setComposingText(text, newCursorPosition)

    val currentSelectionStart = editText.selectionStart
    val noPreviousSelection = previousSelectionStart == previousSelectionEnd
    val cursorDidNotMove = currentSelectionStart == previousSelectionStart
    val cursorMovedBackwardsOrAtBeginningOfInput =
      currentSelectionStart < previousSelectionStart || currentSelectionStart <= 0

    val key =
      if (cursorMovedBackwardsOrAtBeginningOfInput || (!noPreviousSelection && cursorDidNotMove)) {
        BACKSPACE_KEY_VALUE
      } else {
        codePointBeforeCursor(currentSelectionStart)
      }
    if (key.isNotEmpty()) {
      dispatchKeyPressOrEnqueue(key)
    }
    return consumed
  }

  private fun codePointBeforeCursor(cursor: Int): String {
    val content = editText.text ?: return ""
    val end = cursor.coerceAtMost(content.length)
    if (end < 1) return ""
    return String(Character.toChars(Character.codePointBefore(content, end)))
  }

  override fun commitText(
    text: CharSequence,
    newCursorPosition: Int,
  ): Boolean {
    val key = text.toString()
    if (key.length <= 2) {
      dispatchKeyPressOrEnqueue(key.ifEmpty { BACKSPACE_KEY_VALUE })
    }
    return super.commitText(text, newCursorPosition)
  }

  override fun deleteSurroundingText(
    beforeLength: Int,
    afterLength: Int,
  ): Boolean {
    dispatchKeyPress(BACKSPACE_KEY_VALUE)
    if (beforeLength == 1 && afterLength == 0 && editText.deleteLinkBeforeCursor()) {
      return true
    }
    return super.deleteSurroundingText(beforeLength, afterLength)
  }

  override fun sendKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN) {
      val isNumberKey = event.unicodeChar in 48..57
      when (event.keyCode) {
        KeyEvent.KEYCODE_DEL -> dispatchKeyPress(BACKSPACE_KEY_VALUE)
        KeyEvent.KEYCODE_ENTER -> dispatchKeyPress(ENTER_KEY_VALUE)
        else -> if (isNumberKey) dispatchKeyPress(event.number.toString())
      }
      if (event.keyCode == KeyEvent.KEYCODE_DEL && editText.deleteLinkBeforeCursor()) {
        return true
      }
    }
    return super.sendKeyEvent(event)
  }

  private fun dispatchKeyPressOrEnqueue(key: String) {
    if (isBatchEdit) {
      pendingKey = key
    } else {
      dispatchKeyPress(key)
    }
  }

  private fun dispatchKeyPress(key: String) {
    val resolved =
      when (key) {
        NEWLINE_RAW_VALUE -> ENTER_KEY_VALUE
        TAB_RAW_VALUE -> TAB_KEY_VALUE
        else -> key
      }
    editText.eventEmitter.emitKeyPress(resolved)
  }

  companion object {
    private const val NEWLINE_RAW_VALUE = "\n"
    private const val TAB_RAW_VALUE = "\t"
    private const val BACKSPACE_KEY_VALUE = "Backspace"
    private const val ENTER_KEY_VALUE = "Enter"
    private const val TAB_KEY_VALUE = "Tab"
  }
}
