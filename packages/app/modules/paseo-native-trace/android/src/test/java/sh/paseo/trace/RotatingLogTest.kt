package sh.paseo.trace

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.*
import org.junit.Test

class RotatingLogTest {
  private class MemoryStorage : LogStorage {
    val files = linkedMapOf<String, ByteArrayOutputStream>()
    var fail = false
    var opens = 0
    override fun create(part: Int): String {
      val id = "part-$part"
      files[id] = ByteArrayOutputStream()
      return id
    }
    override fun append(id: String): OutputStream {
      opens++
      if (fail) throw IOException("disk full")
      return files.getValue(id)
    }
    override fun newest() = files.keys.reversed()
    override fun delete(id: String) { files.remove(id) }
  }

  @Test fun rotatesAtByteLimitAndKeepsEightIncludingCurrent() {
    val storage = MemoryStorage()
    val log = RotatingLog(storage, { "header:$it\n".toByteArray() }, { throw it }, 20)
    repeat(10) { log.write("123456789012".toByteArray()); log.finishBatch() }
    assertEquals((2..9).map { "part-$it" }, storage.files.keys.toList())
    for (part in 2..9) assertEquals("header:$part\n123456789012", storage.files.getValue("part-$part").toString("UTF-8"))
    assertFalse(log.failed)
  }

  @Test fun reopeningBatchAppendsWithoutRepeatingHeaderAndExactLimitFits() {
    val storage = MemoryStorage()
    val log = RotatingLog(storage, { "H".toByteArray() }, { throw it }, 5)
    log.write("12".toByteArray())
    log.finishBatch()
    log.write("34".toByteArray())
    assertEquals(listOf("part-0"), storage.files.keys.toList())
    assertEquals("H1234", storage.files.getValue("part-0").toString("UTF-8"))
    log.write("5".toByteArray())
    assertEquals("H5", storage.files.getValue("part-1").toString("UTF-8"))
  }

  @Test fun storageFailureStopsRecordingWithoutRetryStorm() {
    val storage = MemoryStorage()
    var failures = 0
    val log = RotatingLog(storage, { byteArrayOf() }, { failures++ })
    storage.fail = true
    repeat(100) { log.write(byteArrayOf(1)); log.finishBatch() }
    assertTrue(log.failed)
    assertEquals(1, failures)
    assertEquals(1, storage.opens)
  }
}
