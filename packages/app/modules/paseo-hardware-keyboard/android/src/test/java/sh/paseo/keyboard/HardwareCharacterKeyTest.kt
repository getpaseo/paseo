package sh.paseo.keyboard
import org.junit.Assert.assertEquals
import org.junit.Test
class HardwareCharacterKeyTest {
  @Test fun deadAccentUsesDomKeyWithoutThrowing() {
    assertEquals("Dead", hardwareCharacterKey(Int.MIN_VALUE or 0xB4))
  }
  @Test fun ordinaryUnicodeRemainsText() {
    assertEquals("é", hardwareCharacterKey(0xE9))
  }
}
