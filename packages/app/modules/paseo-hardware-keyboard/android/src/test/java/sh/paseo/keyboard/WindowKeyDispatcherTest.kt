package sh.paseo.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowKeyDispatcherTest {
  @Test fun observesOnePressAcrossNestedWindows() {
    val dispatcher = WindowKeyDispatcher<Any>()
    val event = Any()
    var observations = 0
    var deliveries = 0
    dispatcher.dispatch(event, { observations++; false }, {
      dispatcher.dispatch(event, { observations++; false }, { deliveries++; false })
    })
    assertEquals(1, observations)
    assertEquals(1, deliveries)
    dispatcher.dispatch(event, { observations++; false }, { false })
    assertEquals(2, observations)
  }
  @Test fun consumedOverlayKeyDoesNotReachTheView() {
    val dispatcher = WindowKeyDispatcher<Any>()
    var deliveries = 0
    assertTrue(dispatcher.dispatch(Any(), { true }, { deliveries++; false }))
    assertEquals(0, deliveries)
  }
}
