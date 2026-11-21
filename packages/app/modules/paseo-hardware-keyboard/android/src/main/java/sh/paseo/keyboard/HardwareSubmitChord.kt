package sh.paseo.keyboard

/**
 * Whether the composer takes a hardware Return press from its text control to send.
 *
 * JavaScript publishes the chords the composer sends with ("Enter", "Control+Enter",
 * "Meta+Enter"), computed from the Send shortcut setting, while the composer can send, so the
 * send policy stays in one place. An overlay that declared Return keeps every Return chord, as
 * on iOS. Shift and Alt Return are never send chords.
 *
 * Plain Return stays with an IME composition that awaits conversion, where it confirms the
 * candidate. Any other composition is text already typed, and a Ctrl or Meta chord never confirms
 * a candidate, so those still send; the caller commits the composition as typed first.
 */
internal fun hardwareSubmitOwns(
  key: String,
  shift: Boolean,
  ctrl: Boolean,
  meta: Boolean,
  alt: Boolean,
  awaitingConversion: Boolean,
  overlayClaimsReturn: Boolean,
  chords: Set<String>,
): Boolean {
  if (key != "Enter" || shift || alt || overlayClaimsReturn) return false
  if (awaitingConversion && !ctrl && !meta) return false
  val chord = buildString {
    if (ctrl) append("Control+")
    if (meta) append("Meta+")
    append("Enter")
  }
  return chord in chords
}

/**
 * Whether Return would confirm this IME composition rather than end text already typed.
 *
 * Japanese and Chinese IMEs compose text that Return converts or confirms: kana, Han, Bopomofo,
 * or Latin pinyin, which only the IME's language gives away. Android keyboards also compose a
 * Hangul syllable or a predicted Latin word; that text is already what the user typed.
 */
internal fun compositionAwaitsConversion(composingText: CharSequence, imeLanguage: String?): Boolean {
  val language = imeLanguage?.lowercase()
  if (language != null && (language.startsWith("ja") || language.startsWith("zh"))) return true
  return composingText.codePoints().anyMatch { codePoint ->
    when (Character.UnicodeScript.of(codePoint)) {
      Character.UnicodeScript.HIRAGANA,
      Character.UnicodeScript.KATAKANA,
      Character.UnicodeScript.HAN,
      Character.UnicodeScript.BOPOMOFO -> true
      else -> false
    }
  }
}
