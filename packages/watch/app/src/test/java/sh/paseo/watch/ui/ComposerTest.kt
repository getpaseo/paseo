package sh.paseo.watch.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The one piece of the composer that is not an Android intent: deciding whether a
 * result is worth sending. Both doors can hand back nothing — a recognizer that heard
 * silence still returns RESULT_OK — and the agent screen sends without confirmation
 * now, so an empty string here becomes an empty turn in the conversation.
 */
class ComposerTest {
  @Test
  fun `trims surrounding whitespace`() {
    assertEquals("ship it", composerText("  ship it \n"))
  }

  @Test
  fun `keeps interior text untouched`() {
    assertEquals("run the tests, then push", composerText("run the tests, then push"))
  }

  @Test
  fun `drops a missing result`() {
    assertNull(composerText(null))
  }

  @Test
  fun `drops an empty result`() {
    assertNull(composerText(""))
  }

  @Test
  fun `drops a whitespace-only result`() {
    assertNull(composerText("   \n\t "))
  }

  @Test
  fun `accepts a CharSequence that is not a String`() {
    assertNull(composerText(StringBuilder("  ")))
    assertEquals("hi", composerText(StringBuilder(" hi ")))
  }
}
