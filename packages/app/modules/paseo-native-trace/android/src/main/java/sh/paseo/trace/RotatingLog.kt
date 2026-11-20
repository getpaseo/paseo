package sh.paseo.trace

import java.io.OutputStream

/** Storage supplies installation-owned files, newest first. */
internal interface LogStorage {
  fun create(part: Int): String
  fun append(id: String): OutputStream
  fun newest(): List<String>
  fun delete(id: String)
}

/** Owns file identity, bounded retention and the terminal storage-failure state. */
internal class RotatingLog(
  private val storage: LogStorage,
  private val header: (Int) -> ByteArray,
  private val onFailure: (Exception) -> Unit,
  private val maxBytes: Int = 5 * 1024 * 1024,
) {
  private var current: String? = null
  private var output: OutputStream? = null
  private var size = 0
  private var part = 0
  var failed = false
    private set

  fun write(bytes: ByteArray) = attempt {
    if (current == null || size + bytes.size > maxBytes) {
      finishBatch()
      if (failed) return@attempt
      val nextPart = part++
      current = storage.create(nextPart)
      output = storage.append(checkNotNull(current))
      val first = header(nextPart)
      output!!.write(first)
      size = first.size
      storage.newest().drop(8).forEach(storage::delete)
    }
    if (output == null) output = storage.append(checkNotNull(current))
    output!!.write(bytes)
    size += bytes.size
  }

  // Closing publishes size and modification time in Android Files.
  fun finishBatch() = attempt {
    output?.close()
    output = null
  }

  private fun attempt(action: () -> Unit) {
    if (failed) return
    try {
      action()
    } catch (error: Exception) {
      failed = true
      runCatching { output?.close() }
      output = null
      onFailure(error)
    }
  }
}
