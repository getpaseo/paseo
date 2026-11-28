package sh.paseo.terminal

import android.text.Editable
import android.text.InputType
import android.text.Selection
import android.text.SpannableStringBuilder
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager

internal data class TerminalKeyPayload(
  val key: String,
  val ctrl: Boolean = false,
  val shift: Boolean = false,
  val alt: Boolean = false,
  val meta: Boolean = false,
)

/**
 * Single authoritative IME + key stream for the Android native terminal.
 *
 * Keeps a private [SpannableStringBuilder] so Android IMEs can compose Hangul, Pinyin, and Latin
 * candidates normally, diffs the editable against what was last sent to the PTY once each batch
 * edit settles, and clears the editable as soon as no composing span remains.
 */
internal class TerminalInputConnection(
  private val targetView: View,
  private val sharedEditable: SpannableStringBuilder = SpannableStringBuilder(),
  private val onInput: (String) -> Unit,
  private val onTerminalKey: (TerminalKeyPayload) -> Unit,
) : BaseInputConnection(targetView, true) {
  private var batchEditDepth = 0
  private var lastSentText = ""
  private var pendingBackspaces = 0
  private var deadAccent = 0
  private var lastSelStart = 0
  private var lastSelEnd = 0
  private var lastCompStart = -1
  private var lastCompEnd = -1

  override fun getEditable(): Editable = sharedEditable

  override fun beginBatchEdit(): Boolean {
    batchEditDepth += 1
    return super.beginBatchEdit()
  }

  override fun endBatchEdit(): Boolean {
    val result = super.endBatchEdit()
    if (batchEditDepth > 0) {
      batchEditDepth -= 1
    }
    if (batchEditDepth == 0) {
      flush()
    }
    return result
  }

  override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.setComposingText(text, newCursorPosition)
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun setComposingRegion(start: Int, end: Int): Boolean {
    val result = super.setComposingRegion(start, end)
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
    val result = super.commitText(text, newCursorPosition)
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun finishComposingText(): Boolean {
    val result = super.finishComposingText()
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
    if (beforeLength <= 0 && afterLength <= 0) return true
    val lengthBefore = sharedEditable.length
    val result = super.deleteSurroundingText(beforeLength, afterLength)
    val deletedChars = maxOf(0, lengthBefore - sharedEditable.length)
    var remaining = maxOf(0, beforeLength - deletedChars)
    if (remaining > 0 && sharedEditable.isNotEmpty()) {
      val toTrim = minOf(remaining, sharedEditable.length)
      sharedEditable.delete(sharedEditable.length - toTrim, sharedEditable.length)
      Selection.setSelection(sharedEditable, sharedEditable.length)
      remaining -= toTrim
    }
    if (remaining > 0) {
      pendingBackspaces += remaining
    }
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
    if (beforeLength <= 0 && afterLength <= 0) return true
    val codePointsBefore = Character.codePointCount(sharedEditable, 0, sharedEditable.length)
    val result = super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    val codePointsAfter = Character.codePointCount(sharedEditable, 0, sharedEditable.length)
    val deletedCodePoints = maxOf(0, codePointsBefore - codePointsAfter)
    var remaining = maxOf(0, beforeLength - deletedCodePoints)
    if (remaining > 0 && codePointsAfter > 0) {
      val toTrim = minOf(remaining, codePointsAfter)
      val trimStart = Character.offsetByCodePoints(sharedEditable, sharedEditable.length, -toTrim)
      sharedEditable.delete(trimStart, sharedEditable.length)
      Selection.setSelection(sharedEditable, sharedEditable.length)
      remaining -= toTrim
    }
    if (remaining > 0) {
      pendingBackspaces += remaining
    }
    if (batchEditDepth == 0) flush()
    return result
  }

  override fun performEditorAction(editorAction: Int): Boolean {
    submitEnter()
    return true
  }

  override fun sendKeyEvent(event: KeyEvent): Boolean {
    return when (event.action) {
      KeyEvent.ACTION_DOWN -> handleKeyDown(event.keyCode, event)
      KeyEvent.ACTION_UP -> isHandledKeyCode(event.keyCode, event)
      @Suppress("DEPRECATION")
      KeyEvent.ACTION_MULTIPLE -> handleKeyMultiple(event)
      else -> false
    }
  }

  override fun closeConnection() {
    resetState()
    super.closeConnection()
  }

  internal fun resetState() {
    batchEditDepth = 0
    pendingBackspaces = 0
    deadAccent = 0
    lastSentText = ""
    clearEditableSilently()
    lastSelStart = 0
    lastSelEnd = 0
    lastCompStart = -1
    lastCompEnd = -1
  }

  internal fun handleKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (KeyEvent.isModifierKey(keyCode)) return false
    if (event.isMetaPressed) return false

    when (keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
        submitEnter(altPressed = event.isAltPressed && !event.isCtrlPressed && !event.isShiftPressed)
        return true
      }
      KeyEvent.KEYCODE_DEL -> {
        handleDeleteKey(altPressed = event.isAltPressed && !event.isCtrlPressed)
        return true
      }
      KeyEvent.KEYCODE_FORWARD_DEL -> {
        deadAccent = 0
        flushAndClear()
        onInput("\u001b[3~")
        return true
      }
      KeyEvent.KEYCODE_TAB -> {
        deadAccent = 0
        flushAndClear()
        val sequence = when {
          event.isShiftPressed && !event.isCtrlPressed && !event.isAltPressed -> "\u001b[Z"
          event.isAltPressed && !event.isCtrlPressed -> "\u001b\t"
          else -> "\t"
        }
        onInput(sequence)
        return true
      }
      KeyEvent.KEYCODE_ESCAPE -> {
        deadAccent = 0
        flushAndClear()
        onInput("\u001b")
        return true
      }
      KeyEvent.KEYCODE_DPAD_UP,
      KeyEvent.KEYCODE_DPAD_DOWN,
      KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_RIGHT -> {
        deadAccent = 0
        val name = when (keyCode) {
          KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
          KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
          KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
          else -> "ArrowRight"
        }
        onTerminalKey(
          TerminalKeyPayload(
            key = name,
            ctrl = event.isCtrlPressed,
            shift = event.isShiftPressed,
            alt = event.isAltPressed,
            meta = event.isMetaPressed,
          ),
        )
        return true
      }
    }

    if (event.isCtrlPressed) {
      val ctrlSeq = encodeCtrlKey(keyCode, event) ?: return false
      deadAccent = 0
      flushAndClear()
      onInput(if (event.isAltPressed) "\u001b$ctrlSeq" else ctrlSeq)
      return true
    }

    if (event.isAltPressed) {
      val withAlt = event.getUnicodeChar(event.metaState)
      val withoutAlt = event.getUnicodeChar(event.metaState and KeyEvent.META_ALT_MASK.inv())
      if (withAlt != 0 && withAlt != withoutAlt) {
        return handleUnicodeChar(withAlt)
      }
      if (withoutAlt != 0 && (withoutAlt and KeyCharacterMap.COMBINING_ACCENT) == 0) {
        deadAccent = 0
        flushAndClear()
        onInput("\u001b" + String(Character.toChars(withoutAlt)))
        return true
      }
      return false
    }

    val unicodeChar = event.getUnicodeChar(event.metaState)
    if (unicodeChar != 0) {
      return handleUnicodeChar(unicodeChar)
    }

    return false
  }

  internal fun handleKeyUp(keyCode: Int, event: KeyEvent): Boolean =
    isHandledKeyCode(keyCode, event)

  @Suppress("DEPRECATION")
  internal fun handleKeyMultiple(event: KeyEvent): Boolean {
    val characters = event.characters ?: return false
    if (characters.isEmpty()) return false
    deadAccent = 0
    flushAndClear()
    onInput(normalizeLineEndings(characters))
    return true
  }

  private fun isHandledKeyCode(keyCode: Int, event: KeyEvent): Boolean {
    if (KeyEvent.isModifierKey(keyCode) || event.isMetaPressed) return false
    return when (keyCode) {
      KeyEvent.KEYCODE_ENTER,
      KeyEvent.KEYCODE_NUMPAD_ENTER,
      KeyEvent.KEYCODE_DEL,
      KeyEvent.KEYCODE_FORWARD_DEL,
      KeyEvent.KEYCODE_TAB,
      KeyEvent.KEYCODE_ESCAPE,
      KeyEvent.KEYCODE_DPAD_UP,
      KeyEvent.KEYCODE_DPAD_DOWN,
      KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_RIGHT -> true
      else -> {
        if (event.isCtrlPressed) return encodeCtrlKey(keyCode, event) != null
        val plainMeta = event.metaState and KeyEvent.META_ALT_MASK.inv()
        event.getUnicodeChar(event.metaState) != 0 ||
          (event.isAltPressed && event.getUnicodeChar(plainMeta) != 0)
      }
    }
  }

  private fun handleUnicodeChar(unicodeChar: Int): Boolean {
    if (unicodeChar and KeyCharacterMap.COMBINING_ACCENT != 0) {
      deadAccent = unicodeChar and KeyCharacterMap.COMBINING_ACCENT_MASK
      return true
    }
    var codePoint = unicodeChar
    if (deadAccent != 0) {
      val combined = KeyEvent.getDeadChar(deadAccent, codePoint)
      val previousAccent = deadAccent
      deadAccent = 0
      if (combined != 0) {
        codePoint = combined
      } else {
        flushAndClear()
        val accentChar =
          KeyEvent.getDeadChar(previousAccent, ' '.code).takeIf { it != 0 } ?: previousAccent
        onInput(String(Character.toChars(accentChar)) + String(Character.toChars(codePoint)))
        return true
      }
    }
    flushAndClear()
    onInput(String(Character.toChars(codePoint)))
    return true
  }

  private fun handleDeleteKey(altPressed: Boolean) {
    deadAccent = 0
    if (altPressed) {
      flushAndClear()
      onInput("\u001b\u007f")
      return
    }
    if (sharedEditable.isNotEmpty()) {
      val end = sharedEditable.length
      val prevCpStart = Character.offsetByCodePoints(sharedEditable, end, -1)
      sharedEditable.delete(prevCpStart, end)
      Selection.setSelection(sharedEditable, sharedEditable.length)
      flush()
    } else {
      onInput("\u007f")
    }
  }

  private fun submitEnter(altPressed: Boolean = false) {
    deadAccent = 0
    flushAndClear()
    onInput(if (altPressed) "\u001b\r" else "\r")
  }

  private fun flush() {
    val out = StringBuilder()
    if (pendingBackspaces > 0) {
      repeat(pendingBackspaces) { out.append('\u007f') }
      pendingBackspaces = 0
    }

    val currentText = sharedEditable.toString()
    val diff = computeDiff(lastSentText, currentText)
    if (diff.isNotEmpty()) {
      out.append(normalizeLineEndings(diff))
    }

    val compStart = getComposingSpanStart(sharedEditable)
    val compEnd = getComposingSpanEnd(sharedEditable)
    val isComposing = compStart >= 0 && compEnd > compStart

    if (!isComposing) {
      val hadText = sharedEditable.isNotEmpty()
      if (hadText || compStart >= 0) {
        clearEditableSilently()
      }
      lastSentText = ""
      if (hadText) {
        // The IME just advanced its cursor for the committed text; report the reset to 0, 0.
        forceUpdateSelection(0, 0, -1, -1)
      } else {
        notifySelectionIfChanged(0, 0, -1, -1)
      }
    } else {
      lastSentText = currentText
      val selStart = maxOf(0, Selection.getSelectionStart(sharedEditable))
      val selEnd = maxOf(0, Selection.getSelectionEnd(sharedEditable))
      notifySelectionIfChanged(selStart, selEnd, compStart, compEnd)
    }

    if (out.isNotEmpty()) {
      onInput(out.toString())
    }
  }

  private fun flushAndClear() {
    batchEditDepth = 0
    val hadText = sharedEditable.isNotEmpty()
    val out = StringBuilder()
    if (pendingBackspaces > 0) {
      repeat(pendingBackspaces) { out.append('\u007f') }
      pendingBackspaces = 0
    }
    val currentText = sharedEditable.toString()
    val diff = computeDiff(lastSentText, currentText)
    if (diff.isNotEmpty()) {
      out.append(normalizeLineEndings(diff))
    }
    if (hadText || getComposingSpanStart(sharedEditable) >= 0) {
      clearEditableSilently()
    }
    lastSentText = ""
    if (hadText || lastSelStart != 0 || lastSelEnd != 0 || lastCompStart != -1 || lastCompEnd != -1) {
      forceUpdateSelection(0, 0, -1, -1)
    }
    if (out.isNotEmpty()) {
      onInput(out.toString())
    }
  }

  private fun clearEditableSilently() {
    removeComposingSpans(sharedEditable)
    sharedEditable.clear()
    Selection.setSelection(sharedEditable, 0)
  }

  private fun notifySelectionIfChanged(selStart: Int, selEnd: Int, compStart: Int, compEnd: Int) {
    if (
      selStart == lastSelStart &&
      selEnd == lastSelEnd &&
      compStart == lastCompStart &&
      compEnd == lastCompEnd
    ) {
      return
    }
    forceUpdateSelection(selStart, selEnd, compStart, compEnd)
  }

  private fun forceUpdateSelection(selStart: Int, selEnd: Int, compStart: Int, compEnd: Int) {
    lastSelStart = selStart
    lastSelEnd = selEnd
    lastCompStart = compStart
    lastCompEnd = compEnd
    val imm = targetView.context.getSystemService(InputMethodManager::class.java) ?: return
    if (imm.isActive(targetView)) {
      imm.updateSelection(targetView, selStart, selEnd, compStart, compEnd)
    }
  }

  companion object {
    internal fun configureEditorInfo(outAttrs: EditorInfo) {
      outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      outAttrs.imeOptions =
        EditorInfo.IME_ACTION_NONE or
          EditorInfo.IME_FLAG_NO_FULLSCREEN or
          EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
      outAttrs.initialSelStart = 0
      outAttrs.initialSelEnd = 0
    }

    private fun normalizeLineEndings(text: String): String =
      text.replace("\r\n", "\r").replace("\n", "\r")

    private fun computeDiff(previous: String, next: String): String {
      if (previous == next) return ""
      val prevCps = previous.toCodePoints()
      val nextCps = next.toCodePoints()
      var common = 0
      val limit = minOf(prevCps.size, nextCps.size)
      while (common < limit && prevCps[common] == nextCps[common]) {
        common += 1
      }
      val removed = prevCps.size - common
      val out = StringBuilder(removed + (nextCps.size - common))
      repeat(removed) { out.append('\u007f') }
      for (i in common until nextCps.size) {
        out.appendCodePoint(nextCps[i])
      }
      return out.toString()
    }

    private fun String.toCodePoints(): IntArray {
      val count = codePointCount(0, length)
      val result = IntArray(count)
      var offset = 0
      var index = 0
      while (offset < length) {
        val cp = codePointAt(offset)
        result[index++] = cp
        offset += Character.charCount(cp)
      }
      return result
    }

    private fun encodeCtrlKey(keyCode: Int, event: KeyEvent): String? {
      val unctrlMeta =
        event.metaState and
          KeyEvent.META_CTRL_MASK.inv() and
          KeyEvent.META_ALT_MASK.inv() and
          KeyEvent.META_META_MASK.inv()
      val unicode = event.getUnicodeChar(unctrlMeta)
      val ch = when {
        unicode != 0 -> unicode.toChar()
        keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z ->
          ('a'.code + keyCode - KeyEvent.KEYCODE_A).toChar()
        keyCode == KeyEvent.KEYCODE_SPACE -> ' '
        else -> return null
      }
      val upper = ch.uppercaseChar()
      return when {
        upper in 'A'..'Z' -> (upper.code - 64).toChar().toString()
        ch == ' ' || ch == '@' || ch == '2' -> "\u0000"
        ch == '[' || ch == '3' -> "\u001b"
        ch == '\\' || ch == '4' -> "\u001c"
        ch == ']' || ch == '5' -> "\u001d"
        ch == '^' || ch == '6' -> "\u001e"
        ch == '_' || ch == '/' || ch == '7' -> "\u001f"
        ch == '8' || ch == '?' -> "\u007f"
        else -> null
      }
    }
  }
}
