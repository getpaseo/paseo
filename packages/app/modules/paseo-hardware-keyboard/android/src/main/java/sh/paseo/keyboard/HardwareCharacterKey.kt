package sh.paseo.keyboard

import android.view.KeyCharacterMap

internal fun hardwareCharacterKey(character: Int): String =
  if (character and KeyCharacterMap.COMBINING_ACCENT != 0) "Dead"
  else String(Character.toChars(character))
