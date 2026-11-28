package sh.paseo.terminal

import android.content.Context
import android.graphics.Rect
import android.text.SpannableStringBuilder
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.viewevent.EventDispatcher
import sh.paseo.keyboard.ComposingTextOwner

/**
 * Focusable 1x1 native Android text editor view that owns the terminal's [InputConnection] and
 * physical keyboard [onKeyDown] delivery directly, bypassing React Native's `TextInput`.
 *
 * Implements [ComposingTextOwner] so `PaseoHardwareKeyboardModule` reads active IME composition
 * reliably even after React Native's `BaseViewManager.setTestId` overwrites `View.getTag()`.
 */
class PaseoTerminalInputView(context: Context) : View(context), ComposingTextOwner {
  private val onTerminalInput by EventDispatcher<Map<String, String>>()
  private val onTerminalKey by EventDispatcher<Map<String, Any>>()
  private val onFocusChange by EventDispatcher<Map<String, Boolean>>()

  private val editable = SpannableStringBuilder()
  private var inputSink: ((String) -> Unit)? = null
  private var keySink: ((TerminalKeyPayload) -> Unit)? = null
  private var focusSink: ((Boolean) -> Unit)? = null
  private var inputConnection: TerminalInputConnection? = null

  init {
    isFocusable = true
    isFocusableInTouchMode = true
    importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
    contentDescription = "Terminal input"
  }

  override fun isComposingText(): Boolean =
    BaseInputConnection.getComposingSpanStart(editable) >= 0

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    TerminalInputConnection.configureEditorInfo(outAttrs)
    val connection = ensureInputConnection()
    connection.resetState()
    return connection
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (ensureInputConnection().handleKeyDown(keyCode, event)) {
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (ensureInputConnection().handleKeyUp(keyCode, event)) {
      return true
    }
    return super.onKeyUp(keyCode, event)
  }

  @Suppress("DEPRECATION")
  override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
    if (ensureInputConnection().handleKeyMultiple(event)) {
      return true
    }
    return super.onKeyMultiple(keyCode, repeatCount, event)
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (!gainFocus) {
      inputConnection?.resetState()
    }
    val sink = focusSink
    if (sink != null) {
      sink(gainFocus)
    } else {
      onFocusChange(mapOf("focused" to gainFocus))
    }
  }

  fun focusInput() {
    showKeyboard()
  }

  fun showKeyboard() {
    val show: () -> Unit = {
      if (!hasFocus()) {
        requestFocus()
      }
      val imm = context.getSystemService(InputMethodManager::class.java)
      imm?.showSoftInput(this, 0)
    }
    if (hasFocus()) {
      show()
    } else {
      requestFocus()
      post(show)
    }
  }

  fun blurInput() {
    inputConnection?.resetState()
    if (hasFocus()) {
      clearFocus()
    }
    val imm = context.getSystemService(InputMethodManager::class.java)
    imm?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun ensureInputConnection(): TerminalInputConnection {
    val existing = inputConnection
    if (existing != null) return existing
    val created = TerminalInputConnection(
      targetView = this,
      sharedEditable = editable,
      onInput = ::emitInput,
      onTerminalKey = ::emitKey,
    )
    inputConnection = created
    return created
  }

  private fun emitInput(data: String) {
    val sink = inputSink
    if (sink != null) {
      sink(data)
    } else {
      onTerminalInput(mapOf("data" to data))
    }
  }

  private fun emitKey(payload: TerminalKeyPayload) {
    val sink = keySink
    if (sink != null) {
      sink(payload)
    } else {
      onTerminalKey(
        mapOf(
          "key" to payload.key,
          "ctrl" to payload.ctrl,
          "shift" to payload.shift,
          "alt" to payload.alt,
          "meta" to payload.meta,
        ),
      )
    }
  }

  companion object {
    internal fun createForTest(
      context: Context,
      onInput: (String) -> Unit = {},
      onTerminalKey: (TerminalKeyPayload) -> Unit = {},
      onFocus: (Boolean) -> Unit = {},
    ): PaseoTerminalInputView =
      PaseoTerminalInputView(context).apply {
        inputSink = onInput
        keySink = onTerminalKey
        focusSink = onFocus
      }
  }
}
