package sh.paseo.trace

import org.junit.Assert.assertEquals
import org.junit.Test

class HeartbeatWatchdogTest {
  @Test fun recordsOneStartAndRecoveryWithMeasuredGap() {
    val events = mutableListOf<Pair<String, Map<String, String>>>()
    val watchdog = HeartbeatWatchdog(0) { name, fields -> events.add(name to fields) }
    watchdog.heartbeat(250)
    watchdog.check(1000)
    assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
    watchdog.check(1001)
    watchdog.check(2000)
    watchdog.heartbeat(2250)
    assertEquals(listOf(
      "js.stall.started" to mapOf("heartbeatGapMs" to "751", "lastHeartbeatMonoMs" to "250"),
      "js.stall.recovered" to mapOf("heartbeatGapMs" to "2000", "overdueMs" to "1750")
    ), events)
  }

  @Test fun backgroundAndResumeDoNotLookLikeStalls() {
    val events = mutableListOf<String>()
    val watchdog = HeartbeatWatchdog(0) { name, _ -> events.add(name) }
    watchdog.active(false, 100)
    watchdog.check(300000)
    watchdog.heartbeat(300100)
    watchdog.active(true, 400000)
    watchdog.heartbeat(400250)
    watchdog.check(400500)
    assertEquals(listOf("app.lifecycle", "app.lifecycle"), events)
  }

  @Test fun recoveryIsReportedEvenIfNativeSamplingMissedTheGap() {
    val events = mutableListOf<String>()
    val watchdog = HeartbeatWatchdog(0) { name, _ -> events.add(name) }
    watchdog.heartbeat(900)
    assertEquals(listOf("js.stall.recovered"), events)
  }
}
