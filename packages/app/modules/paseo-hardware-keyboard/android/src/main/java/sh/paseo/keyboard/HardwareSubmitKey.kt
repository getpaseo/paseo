package sh.paseo.keyboard

/**
 * Which hardware Return presses the composer takes from the text control. The
 * active send shortcut decides: with Enter as the send key every non-Shift
 * Return submits; with Mod+Enter only Ctrl/Meta Return submits. Shift and IME
 * composition always stay with the text control.
 */
internal fun hardwareSubmitOwns(
  key: String,
  shiftPressed: Boolean,
  ctrlPressed: Boolean,
  metaPressed: Boolean,
  composing: Boolean,
  sendShortcut: String,
): Boolean {
  if (key != "Enter" || shiftPressed || composing) return false
  return if (sendShortcut == "mod-enter") ctrlPressed || metaPressed else true
}
