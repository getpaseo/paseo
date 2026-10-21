package sh.paseo.trace

import android.content.Context
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** All serialization and storage belongs to the worker, never the JS/UI threads. */
internal class DiagnosticRecorder(private val context: Context, private val metadata: Map<String, String>) {
  private data class Event(val name: String, val data: Map<String, String>, val monoMs: Long = SystemClock.elapsedRealtime(), val wallMs: Long = System.currentTimeMillis())
  private val queue = ArrayBlockingQueue<Event>(2048)
  private val dropped = AtomicLong()
  private val worker = Executors.newSingleThreadScheduledExecutor()
  private val session = UUID.randomUUID().toString()
  @Volatile private var failed = false
  private val watchdog = HeartbeatWatchdog(SystemClock.elapsedRealtime(), ::record)

  private val log = RotatingLog(DownloadsLogStorage(context, session), { part ->
    serialize(Event("file.start", metadata + mapOf("schema" to "1", "part" to "$part")))
  }, { error ->
    failed = true
    queue.clear()
    Log.e("PaseoDiagnostics", "Diagnostic recording stopped: storage unavailable", error)
  })

  init {
    record("session.start", metadata + mapOf("session" to session, "schema" to "1", "heartbeatMs" to "${HeartbeatTiming.intervalMs}", "stallThresholdMs" to "${HeartbeatTiming.overdueMs}"))
    worker.scheduleWithFixedDelay({ drain() }, 0, HeartbeatTiming.intervalMs, TimeUnit.MILLISECONDS)
  }

  fun record(name: String, data: Map<String, String>) {
    if (failed) return
    // Limit native memory even if an instrumentation caller accidentally supplies large fields.
    val bounded = data.entries.take(24).associate { it.key.take(80) to it.value.take(256) }
    if (!queue.offer(Event(name.take(120), bounded))) dropped.incrementAndGet()
  }

  fun heartbeat() = watchdog.heartbeat(SystemClock.elapsedRealtime())
  fun active(value: Boolean) = watchdog.active(value, SystemClock.elapsedRealtime())

  private fun drain() {
    if (failed) return
    watchdog.check(SystemClock.elapsedRealtime())
    val lost = dropped.getAndSet(0)
    if (lost > 0) write(Event("recorder.dropped", mapOf("count" to "$lost")))
    var remaining = 2048
    while (remaining-- > 0 && !failed) {
      val event = queue.poll() ?: break
      write(event)
    }
    log.finishBatch()
  }

  private fun write(event: Event) = log.write(serialize(event))

  private fun serialize(event: Event): ByteArray = (JSONObject().apply {
    put("event", event.name)
    put("session", session)
    put("wallMs", event.wallMs)
    put("monoMs", event.monoMs)
    put("data", JSONObject(event.data))
  }.toString() + "\n").toByteArray(Charsets.UTF_8)

  fun close() {
    worker.execute {
      record("session.end", emptyMap())
      drain()
      log.finishBatch()
    }
    worker.shutdown()
  }
}
