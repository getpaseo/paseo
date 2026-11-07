package sh.paseo.keyboard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
class HardwareSubmitKeyTest {
  @Test fun enterPolicyOwnsPlainAndModifiedEnter() {
    assertTrue(hardwareSubmitOwns("Enter", false, false, false, false, "enter"))
    assertTrue(hardwareSubmitOwns("Enter", false, true, false, false, "enter"))
    assertTrue(hardwareSubmitOwns("Enter", false, false, true, false, "enter"))
  }
  @Test fun enterPolicyLeavesShiftAndComposition() {
    assertFalse(hardwareSubmitOwns("Enter", true, false, false, false, "enter"))
    assertFalse(hardwareSubmitOwns("Enter", false, true, false, true, "enter"))
  }
  @Test fun modEnterPolicyOwnsOnlyModifiedEnter() {
    assertFalse(hardwareSubmitOwns("Enter", false, false, false, false, "mod-enter"))
    assertTrue(hardwareSubmitOwns("Enter", false, true, false, false, "mod-enter"))
    assertTrue(hardwareSubmitOwns("Enter", false, false, true, false, "mod-enter"))
  }
  @Test fun modEnterPolicyLeavesShiftAndComposition() {
    assertFalse(hardwareSubmitOwns("Enter", true, true, false, false, "mod-enter"))
    assertFalse(hardwareSubmitOwns("Enter", false, true, false, true, "mod-enter"))
  }
  @Test fun otherKeysStayWithTheTextControl() {
    assertFalse(hardwareSubmitOwns("KeyA", false, false, false, false, "enter"))
  }
}
